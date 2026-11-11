-- Ejecutar UNA vez en Supabase > SQL Editor, después de migracion_v7.sql.

-- 1) Agregar columna delivery_time a orders si no existe
alter table public.orders add column if not exists delivery_time time;

-- 2) Actualizar create_order para recibir p_delivery_time (formato militar / time)
create or replace function public.create_order(
  p_customer bigint,
  p_kind text,
  p_note text,
  p_items jsonb,
  p_pays jsonb,
  p_deliver boolean,
  p_delivery_date date,
  p_delivery_time time default null
)
returns bigint language plpgsql security definer set search_path = public as $$
declare oid bigint; tot numeric(10,2); paid numeric := 0; deliv boolean := coalesce(p_deliver, false); ddate date; dtime time;
begin
  if not can_cash() then raise exception 'No tienes permiso para registrar compras'; end if;
  if p_kind not in ('mostrador','envio','apartado') then raise exception 'Tipo de pedido inválido'; end if;
  if p_customer is not null and not exists (select 1 from customers where id = p_customer) then raise exception 'El cliente no existe'; end if;
  if p_kind in ('envio','apartado') and p_customer is null then raise exception 'Un pedido a domicilio o apartado necesita cliente'; end if;
  if p_kind = 'envio' then perform _check_domicilio(p_customer); end if;
  if deliv and p_kind <> 'mostrador' then raise exception 'Solo la entrega en sucursal puede ser inmediata'; end if;
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
  insert into orders(customer_id, kind, delivery, total, note, delivery_date, delivery_time)
  values (p_customer, p_kind, case when p_kind = 'envio' then 'por_enviar' end, 0, left(nullif(trim(p_note), ''), 200), ddate, dtime)
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

-- 3) Actualizar update_order para recibir p_delivery_time
create or replace function public.update_order(
  p_order bigint,
  p_customer bigint,
  p_kind text,
  p_note text,
  p_items jsonb,
  p_delivery_date date,
  p_delivery_time time default null
)
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
    delivery_time = coalesce(p_delivery_time, o.delivery_time),
    delivery = case when p_kind = 'envio' then coalesce(o.delivery, 'por_enviar') else null end,
    assigned_to = case when p_kind = 'envio' then o.assigned_to else null end
  where id = p_order;
  perform _snapshot_order(p_order);
  perform set_config('app.noaudit', '0', true);
  perform _log(auth.uid(), 'editar', 'venta', p_order::text,
    format('Venta #%s editada · total $%s → $%s · %s · entrega %s', p_order, o.total, tot, case p_kind when 'envio' then 'a domicilio' else 'en sucursal' end,
      coalesce(p_delivery_date, o.delivery_date) || coalesce(' ' || to_char(coalesce(p_delivery_time, o.delivery_time), 'HH24:MI') || ' hrs', '')));
end $$;

