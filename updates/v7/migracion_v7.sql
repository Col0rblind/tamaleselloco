-- Ejecutar UNA vez en Supabase > SQL Editor, después de migracion_v6.sql.

-- 1) El cocinero no ve dinero: los pagos solo los leen cajero/general/admin y el repartidor de sus pedidos
drop policy pa_sel on public.payments;
create policy pa_sel on public.payments for select to authenticated using (
  exists (select 1 from public.orders o where o.id = payments.order_id)
  and (public.can_cash() or public.my_cargo() = 'repartidor'));

-- 2) Un envío a domicilio exige dirección completa del cliente
create function public._check_domicilio(p_customer bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from customers where id = p_customer
                 and ((street is not null and colony is not null and street_number is not null) or address is not null)) then
    raise exception 'El cliente no tiene dirección completa (colonia, calle y número). Edítalo en Clientes antes de enviar a domicilio.';
  end if;
end $$;
revoke execute on function public._check_domicilio(bigint) from public, anon, authenticated;

-- 3) Asignar repartidor: solo pedidos a domicilio, solo empleados con cargo repartidor, y no se puede quitar si ya va en camino
create or replace function public.assign_order(p_order bigint, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o orders%rowtype;
begin
  if not can_cash() then raise exception 'No tienes permiso para asignar pedidos'; end if;
  select * into o from orders where id = p_order for update;
  if not found or o.status in ('cancelado','entregado') then raise exception 'Pedido no disponible'; end if;
  if o.kind <> 'envio' then raise exception 'Solo los pedidos a domicilio llevan repartidor'; end if;
  if p_user is null then
    if o.delivery = 'en_camino' then raise exception 'El pedido ya va en camino: no se puede quitar al repartidor'; end if;
  elsif not exists (select 1 from profiles where id = p_user and active and cargo = 'repartidor') then
    raise exception 'Elige un empleado activo con cargo repartidor';
  end if;
  update orders set assigned_to = p_user where id = p_order;
end $$;

-- 4) Crear y editar pedidos: valida la dirección cuando es a domicilio
create or replace function public.create_order(p_customer bigint, p_kind text, p_note text, p_items jsonb, p_pays jsonb, p_deliver boolean, p_delivery_date date)
returns bigint language plpgsql security definer set search_path = public as $$
declare oid bigint; tot numeric(10,2); paid numeric := 0; deliv boolean := coalesce(p_deliver, false); ddate date;
begin
  if not can_cash() then raise exception 'No tienes permiso para registrar compras'; end if;
  if p_kind not in ('mostrador','envio','apartado') then raise exception 'Tipo de pedido inválido'; end if;
  if p_customer is not null and not exists (select 1 from customers where id = p_customer) then raise exception 'El cliente no existe'; end if;
  if p_kind in ('envio','apartado') and p_customer is null then raise exception 'Un pedido a domicilio o apartado necesita cliente'; end if;
  if p_kind = 'envio' then perform _check_domicilio(p_customer); end if;
  if deliv and p_kind <> 'mostrador' then raise exception 'Solo la entrega en sucursal puede ser inmediata'; end if;
  if deliv then ddate := local_today();
  else
    if p_customer is null then raise exception 'Los pedidos por entregar necesitan cliente'; end if;
    if p_delivery_date is null then raise exception 'Elige la fecha de entrega'; end if;
    if p_delivery_date < local_today() then raise exception 'La fecha de entrega no puede ser anterior a hoy'; end if;
    ddate := p_delivery_date;
  end if;
  perform set_config('app.noaudit', '1', true);
  insert into orders(customer_id, kind, delivery, total, note, delivery_date)
  values (p_customer, p_kind, case when p_kind = 'envio' then 'por_enviar' end, 0, left(nullif(trim(p_note), ''), 200), ddate)
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
      case when deliv then 'entregada en sucursal' else 'entrega el ' || ddate end));
  return oid;
end $$;

create or replace function public.update_order(p_order bigint, p_customer bigint, p_kind text, p_note text, p_items jsonb, p_delivery_date date)
returns void language plpgsql security definer set search_path = public as $$
declare o orders%rowtype; tot numeric(10,2); paid numeric;
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
    delivery = case when p_kind = 'envio' then coalesce(o.delivery, 'por_enviar') else null end,
    assigned_to = case when p_kind = 'envio' then o.assigned_to else null end
  where id = p_order;
  perform _snapshot_order(p_order);
  perform set_config('app.noaudit', '0', true);
  perform _log(auth.uid(), 'editar', 'venta', p_order::text,
    format('Venta #%s editada · total $%s → $%s · %s · entrega %s', p_order, o.total, tot, case p_kind when 'envio' then 'a domicilio' else 'en sucursal' end, coalesce(p_delivery_date, o.delivery_date)));
end $$;

-- 5) Estado del pedido: el cocinero no modifica nada; nada sale a reparto sin repartidor asignado
create or replace function public.set_order_status(p_order bigint, p_status text, p_delivery text) returns void
language plpgsql security definer set search_path = public as $$
declare o orders%rowtype; cg text := my_cargo(); adm boolean := is_admin(); saldo numeric; new_del text; new_kind text;
begin
  if cg is null then raise exception 'Sin permiso'; end if;
  if p_status not in ('pendiente','listo','entregado') then raise exception 'Estado inválido'; end if;
  if p_delivery is not null and p_delivery not in ('por_enviar','en_camino','entregado') then raise exception 'Estado de envío inválido'; end if;
  if p_status <> 'entregado' and p_delivery = 'entregado' then raise exception 'Para entregar usa el estado Entregado'; end if;
  select * into o from orders where id = p_order for update;
  if not found or o.status = 'cancelado' then raise exception 'Pedido no disponible'; end if;
  if not adm then
    if cg = 'cocinero' then raise exception 'Sin permiso'; end if;
    if cg = 'repartidor' and (o.assigned_to is distinct from auth.uid() or p_status = 'pendiente') then raise exception 'Sin permiso'; end if;
    if o.status = 'entregado' and p_status <> 'entregado' then raise exception 'Solo el administrador puede reabrir un pedido entregado'; end if;
  end if;
  if p_delivery = 'en_camino' and o.assigned_to is null then raise exception 'Asigna un repartidor antes de enviar el pedido'; end if;
  saldo := o.total - coalesce((select sum(amount) from payments where order_id = p_order), 0);
  if p_status = 'entregado' and saldo > 0.001 then
    raise exception 'Aún hay saldo por cobrar (%). Registra el pago antes de entregar.', saldo;
  end if;
  new_kind := o.kind;
  if o.kind in ('apartado','mostrador') and p_delivery in ('por_enviar','en_camino') then
    if o.customer_id is null then raise exception 'El pedido necesita cliente para enviarse'; end if;
    if saldo > 0.001 then raise exception 'El pedido debe estar pagado por completo para salir a reparto'; end if;
    perform _check_domicilio(o.customer_id);
    new_kind := 'envio';
  end if;
  if p_status in ('listo','entregado') then perform _debit_order(p_order); else perform _credit_order(p_order); end if;
  if new_kind = 'envio' then
    if p_status = 'entregado' then new_del := 'entregado';
    else new_del := coalesce(p_delivery, case when o.delivery = 'entregado' then 'por_enviar' else o.delivery end);
    end if;
  end if;
  update orders set status = p_status, delivery = new_del, kind = new_kind,
    delivered_by = case when p_status = 'entregado' then (case when cg = 'repartidor' then auth.uid() else coalesce(o.assigned_to, auth.uid()) end) else null end
  where id = p_order;
end $$;
