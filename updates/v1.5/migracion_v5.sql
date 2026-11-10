-- Ejecutar UNA vez en Supabase > SQL Editor, después de migracion_v4.sql.

-- 1) Quién reparte y quién entregó
alter table public.orders
  add column assigned_to uuid references public.profiles(id) on delete set null,
  add column delivered_by uuid references public.profiles(id) on delete set null;
create index on public.orders (created_by);
create index on public.orders (customer_id);
create index on public.orders (assigned_to);

-- 2) Lista de personal (nombres) visible para quien tenga sesión activa; sirve para "Registró", filtros y asignación
create or replace function public.staff_list() returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'full_name', full_name, 'cargo', cargo, 'role', role, 'active', active) order by full_name), '[]'::jsonb)
  from profiles where is_active()
$$;

-- 3) Precio editable al registrar la venta (el precio del catálogo es el valor por defecto)
create or replace function public._add_items(p_order bigint, p_items jsonb) returns numeric
language plpgsql security definer set search_path = public as $$
declare it jsonb; pr products%rowtype; q int; pc numeric; tot numeric := 0;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 50 then raise exception 'El pedido no tiene productos'; end if;
  for it in select * from jsonb_array_elements(p_items) loop
    q := (it->>'qty')::int;
    select * into pr from products where id = (it->>'product_id')::bigint and active;
    if not found or q is null or q not between 1 and 1000 then raise exception 'Producto o cantidad inválidos (¿un producto oculto?)'; end if;
    if pr.is_combo and not exists (select 1 from combo_items where combo_id = pr.id) then raise exception 'El combo "%" no tiene tamales', pr.name; end if;
    pc := coalesce(nullif(it->>'price', '')::numeric, pr.price);
    if pc < 0 or pc > 100000 then raise exception 'Precio inválido en "%"', pr.name; end if;
    insert into order_items(order_id, product_id, qty, unit_price) values (p_order, pr.id, q, round(pc, 2));
    tot := tot + round(pc, 2) * q;
  end loop;
  return round(tot, 2);
end $$;

-- 4) Asignar pedido a un repartidor
create or replace function public.assign_order(p_order bigint, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not can_cash() then raise exception 'No tienes permiso para asignar pedidos'; end if;
  if p_user is not null and not exists (select 1 from profiles where id = p_user and active and cargo = 'repartidor') then
    raise exception 'Elige un repartidor activo';
  end if;
  update orders set assigned_to = p_user where id = p_order and status <> 'cancelado';
  if not found then raise exception 'Pedido no disponible'; end if;
end $$;

-- 5) El estado del pedido ahora también guarda quién entregó
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
  update orders set status = p_status, delivery = new_del, kind = new_kind,
    delivered_by = case when p_status = 'entregado' then (case when cg = 'repartidor' then auth.uid() else coalesce(o.assigned_to, auth.uid()) end) else null end,
    assigned_to = case when o.assigned_to is null and cg = 'repartidor' and new_kind = 'envio' then auth.uid() else o.assigned_to end
  where id = p_order;
end $$;

-- 6) Actualizar create_order para soportar precio_custom en items y campos de personal
create or replace function public.create_order(
  p_customer bigint, p_kind text, p_note text, p_items jsonb,
  p_tendered numeric, p_method text, p_deliver boolean
) returns bigint language plpgsql security definer set search_path = public as $$
declare oid bigint; tot numeric; v_paid numeric; it jsonb; pr products%rowtype; q int; pc numeric;
begin
  if not is_active() then raise exception 'Sin permiso'; end if;
  if p_kind not in ('mostrador','apartado') then raise exception 'Tipo de pedido inválido'; end if;
  if p_customer is not null and not exists (select 1 from customers where id = p_customer) then raise exception 'Cliente no existe'; end if;
  if p_kind = 'apartado' and p_customer is null then raise exception 'Un apartado necesita cliente'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 50 then raise exception 'Pedido vacío'; end if;
  insert into orders(customer_id, kind, delivery, total, note, created_by)
  values (p_customer, p_kind, null, 0, left(nullif(trim(p_note),''),200), auth.uid())
  returning id into oid;
  tot := 0;
  for it in select * from jsonb_array_elements(p_items) loop
    q := (it->>'qty')::int;
    select * into pr from products where id = (it->>'product_id')::bigint and active;
    if not found or q is null or q not between 1 and 1000 then raise exception 'Producto o cantidad inválidos'; end if;
    pc := coalesce(nullif(it->>'price','')::numeric, pr.price);
    if pc < 0 or pc > 100000 then raise exception 'Precio inválido'; end if;
    insert into order_items(order_id, product_id, qty, unit_price) values (oid, pr.id, q, round(pc,2));
    tot := tot + round(pc,2) * q;
  end loop;
  update orders set total = tot where id = oid;
  v_paid := round(coalesce(p_tendered,0),2);
  if v_paid > 0 then
    if v_paid > tot then v_paid := tot; end if;
    insert into payments(order_id, amount, method, tendered) values (oid, v_paid, p_method, v_paid);
  end if;
  if p_kind = 'mostrador' and v_paid >= tot and p_deliver then
    update orders set status = 'entregado', delivered_by = auth.uid() where id = oid;
  elsif p_kind = 'mostrador' and v_paid >= tot then
    update orders set status = 'listo' where id = oid;
  end if;
  return oid;
end $$;

-- 7) Función de resumen de ventas para el dashboard
create or replace function public.ventas_resumen(p_desde timestamptz, p_hasta timestamptz)
returns jsonb language plpgsql security definer set search_path = public as $$
declare result jsonb;
begin
  if not is_active() then raise exception 'Sin permiso'; end if;
  select jsonb_build_object(
    'total_vendido', coalesce(sum(o.total) filter (where o.status <> 'cancelado'), 0),
    'total_cobrado', coalesce((select sum(p.amount) from payments p join orders o2 on o2.id = p.order_id where o2.status <> 'cancelado' and p.created_at between p_desde and p_hasta), 0),
    'num_pedidos', count(*) filter (where o.status <> 'cancelado'),
    'num_cancelados', count(*) filter (where o.status = 'cancelado'),
    'por_tipo', (
      select coalesce(jsonb_object_agg(o2.kind, cnt), '{}')
      from (select kind, count(*) as cnt from orders where created_at between p_desde and p_hasta and status <> 'cancelado' group by kind) o2
    ),
    'por_metodo', (
      select coalesce(jsonb_object_agg(p2.method, tot2), '{}')
      from (select p3.method, sum(p3.amount) as tot2 from payments p3 join orders o3 on o3.id = p3.order_id where p3.created_at between p_desde and p_hasta and o3.status <> 'cancelado' group by p3.method) p2
    ),
    'top_productos', (
      select coalesce(jsonb_agg(jsonb_build_object('name', pr.name, 'qty', sum(oi.qty), 'total', sum(oi.qty * oi.unit_price)) order by sum(oi.qty) desc), '[]')
      from order_items oi join orders o4 on o4.id = oi.order_id join products pr on pr.id = oi.product_id
      where o4.created_at between p_desde and p_hasta and o4.status <> 'cancelado'
      group by pr.id, pr.name limit 5
    ),
    'top_clientes', (
      select coalesce(jsonb_agg(jsonb_build_object('name', c.name, 'total', sum(o5.total)) order by sum(o5.total) desc), '[]')
      from orders o5 join customers c on c.id = o5.customer_id
      where o5.created_at between p_desde and p_hasta and o5.status <> 'cancelado' and o5.customer_id is not null
      group by c.id, c.name limit 5
    )
  ) into result
  from orders o
  where o.created_at between p_desde and p_hasta;
  return result;
end $$;
