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
