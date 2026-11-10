-- Ejecutar UNA vez en Supabase > SQL Editor, DESPUÉS de supabase.sql.

-- 1) Usuario en lugar de correo
alter table public.profiles add column username text;
alter table public.profiles add constraint profiles_username_chk check (username is null or username ~ '^[a-z0-9._]{3,20}$');
create unique index profiles_username_key on public.profiles (lower(username));

-- 2) Solicitudes de "olvidé mi contraseña"
create table public.reset_requests (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  handled boolean not null default false
);
create unique index on public.reset_requests (user_id) where not handled;
alter table public.reset_requests enable row level security;
create policy rr_select on public.reset_requests for select to authenticated using (public.is_admin());

-- Cualquiera (sin sesión) puede pedirla, pero nunca se revela si el usuario existe
create or replace function public.request_reset(p_username text) returns void
language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  select id into uid from profiles where lower(username) = lower(trim(p_username)) and active;
  if uid is not null then insert into reset_requests(user_id) values (uid) on conflict do nothing; end if;
end $$;

-- 3) Negocio
create table public.customers (
  id bigint generated always as identity primary key,
  name text not null check (char_length(name) between 2 and 80),
  phone text check (phone is null or phone ~ '^[0-9+() -]{7,20}$'),
  address text check (address is null or char_length(address) <= 200),
  created_at timestamptz not null default now()
);
create table public.products (
  id bigint generated always as identity primary key,
  name text not null check (char_length(name) between 2 and 60),
  description text check (description is null or char_length(description) <= 160),
  price numeric(10,2) not null check (price >= 0 and price <= 100000),
  active boolean not null default true
);
create table public.orders (
  id bigint generated always as identity primary key,
  customer_id bigint references public.customers(id) on delete restrict,
  kind text not null check (kind in ('mostrador','envio')),
  status text not null default 'pendiente' check (status in ('pendiente','listo','entregado','cancelado')),
  delivery text check (delivery in ('por_enviar','en_camino','entregado')),
  total numeric(10,2) not null check (total >= 0),
  note text check (note is null or char_length(note) <= 200),
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  check ((kind = 'envio') = (delivery is not null)),
  check (kind = 'mostrador' or customer_id is not null)
);
create table public.order_items (
  id bigint generated always as identity primary key,
  order_id bigint not null references public.orders(id) on delete cascade,
  product_id bigint not null references public.products(id) on delete restrict,
  qty int not null check (qty between 1 and 1000),
  unit_price numeric(10,2) not null
);
create table public.payments (
  id bigint generated always as identity primary key,
  order_id bigint not null references public.orders(id) on delete cascade,
  amount numeric(10,2) not null check (amount > 0),
  method text not null check (method in ('efectivo','transferencia','tarjeta')),
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now()
);
create table public.cash_closures (
  id bigint generated always as identity primary key,
  from_ts timestamptz not null,
  to_ts timestamptz not null default now(),
  efectivo numeric(10,2) not null,
  transferencia numeric(10,2) not null,
  tarjeta numeric(10,2) not null,
  closed_by uuid not null default auth.uid() references auth.users(id)
);
create index on public.orders (created_at desc);
create index on public.payments (order_id);
create index on public.payments (created_at);

alter table public.customers enable row level security;
alter table public.products enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.payments enable row level security;
alter table public.cash_closures enable row level security;

-- Lectura: usuarios activos. Escritura directa: solo lo mínimo; pedidos y abonos SOLO por funciones validadas.
create policy cu_sel on public.customers for select to authenticated using (public.is_active());
create policy cu_ins on public.customers for insert to authenticated with check (public.is_active());
create policy cu_del on public.customers for delete to authenticated using (public.is_admin());
create policy pr_sel on public.products for select to authenticated using (public.is_active());
create policy pr_w   on public.products for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy or_sel on public.orders for select to authenticated using (public.is_active());
create policy or_del on public.orders for delete to authenticated using (public.is_admin());
create policy oi_sel on public.order_items for select to authenticated using (public.is_active());
create policy pa_sel on public.payments for select to authenticated using (public.is_active());
create policy pa_del on public.payments for delete to authenticated using (public.is_admin());
create policy cc_sel on public.cash_closures for select to authenticated using (public.is_active());
create policy cc_del on public.cash_closures for delete to authenticated using (public.is_admin());

-- Crear pedido: el total se calcula AQUÍ con los precios de la base, nunca con lo que mande el navegador
create or replace function public.create_order(p_customer bigint, p_kind text, p_note text, p_items jsonb, p_paid numeric, p_method text)
returns bigint language plpgsql security definer set search_path = public as $$
declare oid bigint; tot numeric(10,2) := 0; it jsonb; pr products%rowtype; q int; v_paid numeric(10,2) := round(coalesce(p_paid,0),2);
begin
  if not is_active() then raise exception 'Sin permiso'; end if;
  if p_kind not in ('mostrador','envio') then raise exception 'Tipo de pedido inválido'; end if;
  if p_customer is not null and not exists (select 1 from customers where id = p_customer) then raise exception 'Cliente no existe'; end if;
  if p_kind = 'envio' and p_customer is null then raise exception 'Un envío necesita cliente'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 50 then raise exception 'Pedido vacío'; end if;
  insert into orders(customer_id, kind, delivery, total, note)
  values (p_customer, p_kind, case when p_kind = 'envio' then 'por_enviar' end, 0, left(nullif(trim(p_note),''),200))
  returning id into oid;
  for it in select * from jsonb_array_elements(p_items) loop
    q := (it->>'qty')::int;
    select * into pr from products where id = (it->>'product_id')::bigint and active;
    if not found or q not between 1 and 1000 then raise exception 'Producto o cantidad inválidos'; end if;
    insert into order_items(order_id, product_id, qty, unit_price) values (oid, pr.id, q, pr.price);
    tot := tot + pr.price * q;
  end loop;
  update orders set total = tot where id = oid;
  if v_paid > 0 then
    if v_paid > tot then raise exception 'El abono supera el total'; end if;
    insert into payments(order_id, amount, method) values (oid, v_paid, p_method);
  end if;
  if p_kind = 'mostrador' and v_paid = tot then update orders set status = 'entregado' where id = oid; end if;
  return oid;
end $$;

create or replace function public.add_payment(p_order bigint, p_amount numeric, p_method text) returns void
language plpgsql security definer set search_path = public as $$
declare o orders%rowtype; paid numeric;
begin
  if not is_active() then raise exception 'Sin permiso'; end if;
  select * into o from orders where id = p_order for update;
  if not found or o.status = 'cancelado' then raise exception 'Pedido no disponible'; end if;
  select coalesce(sum(amount),0) into paid from payments where order_id = p_order;
  if p_amount is null or p_amount <= 0 or round(p_amount,2) > o.total - paid then
    raise exception 'Abono inválido: el máximo es %', o.total - paid;
  end if;
  insert into payments(order_id, amount, method) values (p_order, round(p_amount,2), p_method);
end $$;

create or replace function public.set_order_status(p_order bigint, p_status text, p_delivery text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_active() then raise exception 'Sin permiso'; end if;
  if p_status not in ('pendiente','listo','entregado') then raise exception 'Estado inválido'; end if;
  update orders set status = p_status,
    delivery = case when kind = 'envio' then coalesce(p_delivery, delivery) else null end
  where id = p_order and status <> 'cancelado';
  if not found then raise exception 'Pedido no disponible'; end if;
end $$;

create or replace function public.cancel_order(p_order bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Solo el administrador puede cancelar'; end if;
  update orders set status = 'cancelado' where id = p_order;
end $$;

create or replace function public.close_cash() returns cash_closures
language plpgsql security definer set search_path = public as $$
declare f timestamptz; r cash_closures;
begin
  if not is_active() then raise exception 'Sin permiso'; end if;
  select coalesce(max(to_ts), '2000-01-01') into f from cash_closures;
  insert into cash_closures(from_ts, to_ts, efectivo, transferencia, tarjeta)
  select f, now(),
    coalesce(sum(p.amount) filter (where p.method = 'efectivo'), 0),
    coalesce(sum(p.amount) filter (where p.method = 'transferencia'), 0),
    coalesce(sum(p.amount) filter (where p.method = 'tarjeta'), 0)
  from payments p join orders o on o.id = p.order_id
  where p.created_at > f and p.created_at <= now() and o.status <> 'cancelado'
  returning * into r;
  return r;
end $$;

-- Almacenamiento (solo admin)
create or replace function public.db_usage() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Solo el administrador'; end if;
  return jsonb_build_object(
    'bytes', pg_database_size(current_database()),
    'tables', (select coalesce(jsonb_object_agg(c.relname::text, pg_total_relation_size(c.oid)), '{}'::jsonb)
               from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public' and c.relkind = 'r'));
end $$;

create or replace function public.purge_data(p_target text, p_days int) returns int
language plpgsql security definer set search_path = public as $$
declare n int := 0;
begin
  if not is_admin() then raise exception 'Solo el administrador'; end if;
  if p_days is null or p_days < 30 then raise exception 'Mínimo 30 días'; end if;
  if p_target = 'ollas' then
    delete from batches where created_at < now() - make_interval(days => p_days);
  elsif p_target = 'ventas' then
    delete from orders o where o.created_at < now() - make_interval(days => p_days)
      and o.status in ('entregado','cancelado')
      and (o.status = 'cancelado' or o.total <= coalesce((select sum(amount) from payments p where p.order_id = o.id), 0));
  else
    raise exception 'Opción inválida';
  end if;
  get diagnostics n = row_count;
  return n;
end $$;

alter publication supabase_realtime add table public.orders, public.payments, public.reset_requests;
