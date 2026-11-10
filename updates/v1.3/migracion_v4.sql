-- Ejecutar UNA vez en Supabase > SQL Editor, después de migracion_v3.sql.
-- Permite que un apartado pagado por completo pase a ENVÍO (Salió a reparto).

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
    if cg = 'repartidor' and (o.kind <> 'envio' or p_status = 'pendiente') then raise exception 'Sin permiso'; end if;
    if cg = 'cocinero' and (o.kind <> 'envio' or p_status = 'entregado') then raise exception 'Sin permiso'; end if;
    if o.status = 'entregado' and p_status <> 'entregado' then raise exception 'Solo el administrador puede reabrir un pedido entregado'; end if;
  end if;
  saldo := o.total - coalesce((select sum(amount) from payments where order_id = p_order), 0);
  if p_status = 'entregado' and saldo > 0.001 then
    raise exception 'Aún hay saldo por cobrar (%). Registra el pago antes de entregar.', saldo;
  end if;
  new_kind := o.kind;
  if o.kind = 'apartado' and p_delivery in ('por_enviar','en_camino') then
    if o.customer_id is null then raise exception 'El apartado necesita cliente para enviarse'; end if;
    if saldo > 0.001 then raise exception 'El apartado debe estar pagado por completo para enviarse'; end if;
    new_kind := 'envio';
  end if;
  if p_status in ('listo','entregado') then perform _debit_order(p_order); else perform _credit_order(p_order); end if;
  if new_kind = 'envio' then
    if p_status = 'entregado' then new_del := 'entregado';
    else new_del := coalesce(p_delivery, case when o.delivery = 'entregado' then 'por_enviar' else o.delivery end);
    end if;
  end if;
  update orders set status = p_status, delivery = new_del, kind = new_kind where id = p_order;
end $$;
