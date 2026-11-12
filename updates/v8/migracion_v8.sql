-- Ejecutar UNA vez en Supabase > SQL Editor, después de migracion_v7.sql / migracion_v8.sql.

-- 1) Agregar columnas delivery_time y responsible_id a orders si no existen
alter table public.orders add column if not exists delivery_time time;
alter table public.orders add column if not exists responsible_id uuid references public.profiles(id) on delete set null;

-- 2) Actualizar can_kitchen para que cualquier usuario activo pueda registrar y gestionar tamales en TAMALES
create or replace function public.can_kitchen() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_active()
$$;

-- 3) Convertir cualquier perfil con cargo 'cocinero' o 'repartidor' a 'general'
update public.profiles set cargo = 'general' where cargo in ('cocinero', 'repartidor');

-- 4) Políticas de RLS para pagos (payments): permitir actualizar y cancelar a quienes tengan can_cash()
drop policy if exists pa_sel on public.payments;
create policy pa_sel on public.payments for select to authenticated using (public.is_active());

drop policy if exists pa_upd on public.payments;
create policy pa_upd on public.payments for update to authenticated using (public.can_cash()) with check (public.can_cash());

drop policy if exists pa_del on public.payments;
create policy pa_del on public.payments for delete to authenticated using (public.can_cash());

-- 5) Políticas de RLS para corte de caja (cash_closures): permitir editar a can_cash()
drop policy if exists cc_upd on public.cash_closures;
create policy cc_upd on public.cash_closures for update to authenticated using (public.can_cash()) with check (public.can_cash());

drop policy if exists cc_del on public.cash_closures;
create policy cc_del on public.cash_closures for delete to authenticated using (public.can_cash());

-- 6) RPCs para editar y cancelar abonos / pagos
create or replace function public.edit_payment(
  p_payment bigint,
  p_amount numeric,
  p_method text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_old payments%rowtype;
begin
  if not can_cash() then raise exception 'No tienes permiso para modificar abonos'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'El monto del abono debe ser mayor a cero'; end if;
  if p_method not in ('efectivo', 'transferencia', 'tarjeta') then raise exception 'Método de pago inválido'; end if;

  select * into v_old from payments where id = p_payment for update;
  if not found then raise exception 'El abono no existe'; end if;

  update payments set amount = round(p_amount, 2), method = p_method where id = p_payment;

  perform _log(auth.uid(), 'editar', 'pago', p_payment::text,
    format('Abono #%s editado: $%s (%s) → $%s (%s)', p_payment, v_old.amount, v_old.method, round(p_amount, 2), p_method));
end $$;

create or replace function public.cancel_payment(
  p_payment bigint
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_old payments%rowtype;
begin
  if not can_cash() then raise exception 'No tienes permiso para cancelar abonos'; end if;

  select * into v_old from payments where id = p_payment for update;
  if not found then raise exception 'El abono no existe'; end if;

  delete from payments where id = p_payment;

  perform _log(auth.uid(), 'eliminar', 'pago', p_payment::text,
    format('Abono #%s de $%s (%s) de la orden #%s cancelado/eliminado', p_payment, v_old.amount, v_old.method, v_old.order_id));
end $$;

-- 7) RPC para editar corte de caja
create or replace function public.edit_cash_closure(
  p_closure bigint,
  p_efectivo numeric,
  p_transferencia numeric,
  p_tarjeta numeric
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_old cash_closures%rowtype;
begin
  if not can_cash() then raise exception 'No tienes permiso para modificar cortes de caja'; end if;

  select * into v_old from cash_closures where id = p_closure for update;
  if not found then raise exception 'El corte de caja no existe'; end if;

  update cash_closures
  set efectivo = round(coalesce(p_efectivo, 0), 2),
      transferencia = round(coalesce(p_transferencia, 0), 2),
      tarjeta = round(coalesce(p_tarjeta, 0), 2)
  where id = p_closure;

  perform _log(auth.uid(), 'editar', 'corte', p_closure::text,
    format('Corte #%s editado · Efvo: $%s → $%s · Transf: $%s → $%s · Tarj: $%s → $%s',
      p_closure, v_old.efectivo, round(coalesce(p_efectivo, 0), 2),
      v_old.transferencia, round(coalesce(p_transferencia, 0), 2),
      v_old.tarjeta, round(coalesce(p_tarjeta, 0), 2)));
end $$;

-- 8) Actualizar create_order para incluir delivery_time y responsible_id
create or replace function public.create_order(
  p_customer bigint,
  p_kind text,
  p_note text,
  p_items jsonb,
  p_pays jsonb,
  p_deliver boolean,
  p_delivery_date date,
  p_delivery_time time default null,
  p_responsible uuid default null
)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  oid bigint;
  tot numeric(10,2);
  paid numeric := 0;
  deliv boolean := coalesce(p_deliver, false);
  ddate date;
  dtime time;
  v_resp uuid;
begin
  if not can_cash() then raise exception 'No tienes permiso para registrar compras'; end if;
  if p_kind not in ('mostrador','envio','apartado') then raise exception 'Tipo de pedido inválido'; end if;
  if p_customer is not null and not exists (select 1 from customers where id = p_customer) then raise exception 'El cliente no existe'; end if;
  if p_kind in ('envio','apartado') and p_customer is null then raise exception 'Un pedido a domicilio o apartado necesita cliente'; end if;
  if p_kind = 'envio' then perform _check_domicilio(p_customer); end if;
  if deliv and p_kind <> 'mostrador' then raise exception 'Solo la entrega en sucursal puede ser inmediata'; end if;

  v_resp := coalesce(p_responsible, auth.uid());

  if deliv then
    ddate := local_today();
    dtime := null;
  else
    if p_customer is null then raise exception 'Los pedidos por entregar necesitan cliente'; end if;
    if p_delivery_date is null then raise exception 'Elige la fecha de entrega'; end if;
    if p_delivery_date < local_today() then raise exception 'La fecha de entrega no puede ser anterior a hoy'; end if;
    ddate := p_delivery_date;
    dtime := p_delivery_time;
  end if;

  perform set_config('app.noaudit', '1', true);
  insert into orders(customer_id, kind, delivery, total, note, delivery_date, delivery_time, responsible_id)
  values (p_customer, p_kind, case when p_kind = 'envio' then 'por_enviar' end, 0, left(nullif(trim(p_note), ''), 200), ddate, dtime, v_resp)
  returning id into oid;

  tot := _add_items(oid, p_items);
  update orders set total = tot where id = oid;
  perform _snapshot_order(oid);
  perform _apply_payments(oid, p_pays);
  select coalesce(sum(amount), 0) into paid from payments where order_id = oid;

  if deliv then
    if paid < tot then raise exception 'Para entregar en sucursal el pago debe estar completo'; end if;
    perform _debit_order(oid);
    update orders set status = 'entregado' where id = oid;
  end if;

  perform set_config('app.noaudit', '0', true);
  perform _log(auth.uid(), 'crear', 'venta', oid::text,
    format('Venta #%s · %s · total $%s · pagado $%s · %s', oid, case p_kind when 'envio' then 'a domicilio' else 'en sucursal' end, tot, paid,
      case when deliv then 'entregada en sucursal' else 'entrega el ' || ddate || coalesce(' a las ' || to_char(dtime, 'HH24:MI') || ' hrs', '') end));
  return oid;
end $$;

-- 9) Actualizar update_order para incluir delivery_time y responsible_id
create or replace function public.update_order(
  p_order bigint,
  p_customer bigint,
  p_kind text,
  p_note text,
  p_items jsonb,
  p_delivery_date date,
  p_delivery_time time default null,
  p_responsible uuid default null
)
returns void language plpgsql security definer set search_path = public as $$
declare
  o orders%rowtype;
  tot numeric(10,2);
  paid numeric;
begin
  if not can_cash() then raise exception 'No tienes permiso para editar pedidos'; end if;
  select * into o from orders where id = p_order for update;
  if not found or o.status in ('cancelado','entregado') then raise exception 'Este pedido ya no se puede editar'; end if;
  if o.stock_debited then raise exception 'El pedido ya está listo. Regrésalo a pendiente para editarlo.'; end if;
  if p_kind not in ('mostrador','envio','apartado') then raise exception 'Tipo de pedido inválido'; end if;
  if p_customer is null then raise exception 'Los pedidos por entregar necesitan cliente'; end if;
  if not exists (select 1 from customers where id = p_customer) then raise exception 'El cliente no existe'; end if;
  if p_kind = 'envio' then perform _check_domicilio(p_customer); end if;
  if o.delivery = 'en_camino' and p_kind <> 'envio' then raise exception 'El pedido ya va en camino'; end if;
  if p_delivery_date is not null and p_delivery_date <> coalesce(o.delivery_date, date '1900-01-01') and p_delivery_date < local_today() then
    raise exception 'La fecha de entrega no puede ser anterior a hoy';
  end if;

  perform set_config('app.noaudit', '1', true);
  delete from order_items where order_id = p_order;
  tot := _add_items(p_order, p_items);
  select coalesce(sum(amount), 0) into paid from payments where order_id = p_order;
  if tot < paid then raise exception 'El nuevo total (%) es menor a lo ya abonado (%). Pide al administrador ajustar los abonos.', tot, paid; end if;

  update orders set customer_id = p_customer, kind = p_kind, total = tot, note = left(nullif(trim(p_note), ''), 200),
    delivery_date = coalesce(p_delivery_date, o.delivery_date),
    delivery_time = coalesce(p_delivery_time, o.delivery_time),
    responsible_id = coalesce(p_responsible, o.responsible_id, auth.uid()),
    delivery = case when p_kind = 'envio' then coalesce(o.delivery, 'por_enviar') else null end,
    assigned_to = case when p_kind = 'envio' then o.assigned_to else null end
  where id = p_order;

  perform _snapshot_order(p_order);
  perform set_config('app.noaudit', '0', true);
  perform _log(auth.uid(), 'editar', 'venta', p_order::text,
    format('Venta #%s editada · total $%s → $%s · %s · entrega %s', p_order, o.total, tot, case p_kind when 'envio' then 'a domicilio' else 'en sucursal' end,
      coalesce(p_delivery_date, o.delivery_date) || coalesce(' ' || to_char(coalesce(p_delivery_time, o.delivery_time), 'HH24:MI') || ' hrs', '')));
end $$;

-- 10) Actualizar set_order_status eliminando la restricción de repartidor
create or replace function public.set_order_status(
  p_order bigint,
  p_status text,
  p_delivery text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  o orders%rowtype;
  cg text := my_cargo();
  adm boolean := is_admin();
  saldo numeric;
  new_del text;
  new_kind text;
begin
  if not can_cash() then raise exception 'Sin permiso'; end if;
  if p_status not in ('pendiente','listo','entregado') then raise exception 'Estado inválido'; end if;
  if p_delivery is not null and p_delivery not in ('por_enviar','en_camino','entregado') then raise exception 'Estado de entrega inválido'; end if;
  if p_status <> 'entregado' and p_delivery = 'entregado' then raise exception 'Para entregar usa el estado Entregado'; end if;

  select * into o from orders where id = p_order for update;
  if not found or o.status = 'cancelado' then raise exception 'Pedido no disponible'; end if;

  if not adm then
    if o.status = 'entregado' and p_status <> 'entregado' then raise exception 'Solo el administrador puede reabrir un pedido entregado'; end if;
  end if;

  saldo := o.total - coalesce((select sum(amount) from payments where order_id = p_order), 0);
  if p_status = 'entregado' and saldo > 0.001 then
    raise exception 'Aún hay saldo por cobrar (%). Registra el pago antes de entregar.', saldo;
  end if;

  new_kind := o.kind;
  if o.kind in ('apartado','mostrador') and p_delivery in ('por_enviar','en_camino') then
    if o.customer_id is null then raise exception 'El pedido necesita cliente para entregarse a domicilio'; end if;
    if saldo > 0.001 then raise exception 'El pedido debe estar pagado por completo para salir a entrega'; end if;
    perform _check_domicilio(o.customer_id);
    new_kind := 'envio';
  end if;

  if p_status in ('listo','entregado') then perform _debit_order(p_order); else perform _credit_order(p_order); end if;

  if new_kind = 'envio' then
    if p_status = 'entregado' then
      new_del := 'entregado';
    else
      new_del := coalesce(p_delivery, case when o.delivery = 'entregado' then 'por_enviar' else o.delivery end);
    end if;
  end if;

  update orders
  set status = p_status,
      delivery = new_del,
      kind = new_kind,
      delivered_by = case when p_status = 'entregado' then coalesce(o.assigned_to, auth.uid()) else null end
  where id = p_order;
end $$;
