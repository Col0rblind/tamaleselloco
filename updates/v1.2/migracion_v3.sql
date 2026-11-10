-- Ejecutar UNA vez en Supabase > SQL Editor, DESPUÉS de supabase.sql y migracion_v2.sql.

-- 1) Cargo y celular del empleado
alter table public.profiles
  add column cargo text not null default 'general' check (cargo in ('cajero','repartidor','cocinero','general')),
  add column phone text check (phone is null or phone ~ '^[0-9]{10}$');

-- 2) Dirección separada del cliente
alter table public.customers
  add column colony text check (colony is null or char_length(colony) <= 60),
  add column street text check (street is null or char_length(street) <= 80),
  add column street_number text check (street_number is null or char_length(street_number) <= 10);

-- 3) Productos: sabor, combos, imagen
alter table public.products
  add column salsa_id bigint references public.categories(id) on delete restrict,
  add column is_combo boolean not null default false,
  add column image text check (image is null or char_length(image) <= 120);
alter table public.products add constraint products_salsa_chk check (is_combo or salsa_id is not null) not valid;
alter table public.products add constraint products_combo_chk check (not is_combo or salsa_id is null);

create table public.combo_items (
  id bigint generated always as identity primary key,
  combo_id bigint not null references public.products(id) on delete cascade,
  product_id bigint not null references public.products(id) on delete restrict,
  qty int not null check (qty between 1 and 1000),
  unique (combo_id, product_id)
);

create function public._check_product() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and old.is_combo <> new.is_combo then raise exception 'No se puede cambiar entre tamal y combo'; end if;
  if new.salsa_id is not null and not exists (select 1 from categories where id = new.salsa_id and kind = 'salsa') then
    raise exception 'Sabor inválido';
  end if;
  return new;
end $$;
create trigger trg_check_product before insert or update on public.products for each row execute function public._check_product();

create function public._check_combo_item() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from products where id = new.combo_id and is_combo) then raise exception 'No es un combo'; end if;
  if not exists (select 1 from products where id = new.product_id and not is_combo and salsa_id is not null) then
    raise exception 'Un combo solo puede contener tamales individuales con sabor';
  end if;
  return new;
end $$;
create trigger trg_check_combo_item before insert or update on public.combo_items for each row execute function public._check_combo_item();

-- 4) Pedidos: apartado, cambio, inventario
alter table public.orders drop constraint if exists orders_kind_check;
alter table public.orders add constraint orders_kind_check check (kind in ('mostrador','envio','apartado'));
alter table public.orders add column stock_debited boolean not null default false;
update public.orders set stock_debited = true where status in ('listo','entregado');   -- historial anterior: no se descuenta
alter table public.payments add column tendered numeric(10,2);
alter table public.payments add constraint payments_tendered_chk check (tendered is null or tendered >= amount);

-- Tamales disponibles por sabor y "foto" de lo que necesita cada pedido
create table public.stock (
  salsa_id bigint primary key references public.categories(id) on delete cascade,
  qty int not null default 0 check (qty >= 0)
);
insert into public.stock (salsa_id, qty) select salsa_id, sum(qty) from public.batches group by salsa_id;
create table public.order_tamales (
  order_id bigint not null references public.orders(id) on delete cascade,
  salsa_id bigint not null references public.categories(id) on delete restrict,
  qty int not null check (qty > 0),
  primary key (order_id, salsa_id)
);

-- 5) Permisos por cargo
create function public.my_cargo() returns text language sql stable security definer set search_path = public as
$$ select case when p.active and not p.must_change then p.cargo end from profiles p where p.id = auth.uid() $$;
create function public.can_kitchen() returns boolean language sql stable security definer set search_path = public as
$$ select public.is_admin() or coalesce(public.my_cargo() in ('cocinero','general'), false) $$;
create function public.can_cash() returns boolean language sql stable security definer set search_path = public as
$$ select public.is_admin() or coalesce(public.my_cargo() in ('cajero','general'), false) $$;

alter table public.stock enable row level security;
alter table public.order_tamales enable row level security;
alter table public.combo_items enable row level security;

drop policy cu_sel on public.customers;  drop policy cu_ins on public.customers;
drop policy or_sel on public.orders;     drop policy oi_sel on public.order_items;
drop policy pa_sel on public.payments;
drop policy b_insert on public.batches;  drop policy b_update on public.batches;  drop policy b_delete on public.batches;

-- Repartidor y cocinero solo ven ENVÍOS; cajero y general ven todo; admin todo
create policy or_sel on public.orders for select to authenticated using (
  public.can_cash() or (public.my_cargo() in ('cocinero','repartidor') and kind = 'envio'));
create policy oi_sel on public.order_items for select to authenticated using (exists (select 1 from public.orders o where o.id = order_items.order_id));
create policy pa_sel on public.payments for select to authenticated using (exists (select 1 from public.orders o where o.id = payments.order_id));
create policy ot_sel on public.order_tamales for select to authenticated using (exists (select 1 from public.orders o where o.id = order_tamales.order_id));
create policy cu_sel on public.customers for select to authenticated using (
  public.can_cash() or exists (select 1 from public.orders o where o.customer_id = customers.id));
create policy cu_ins on public.customers for insert to authenticated with check (public.can_cash());
create policy cu_upd on public.customers for update to authenticated using (public.can_cash()) with check (public.can_cash());
create policy st_sel on public.stock for select to authenticated using (public.is_active());
create policy ci_sel on public.combo_items for select to authenticated using (public.is_active());
create policy ci_w   on public.combo_items for all to authenticated using (public.is_admin()) with check (public.is_admin());
-- Cocina: el cocinero puede registrar, corregir y eliminar ollas
create policy b_insert on public.batches for insert to authenticated with check (public.can_kitchen() and created_by = auth.uid());
create policy b_update on public.batches for update to authenticated using (public.can_kitchen()) with check (public.can_kitchen());
create policy b_delete on public.batches for delete to authenticated using (public.can_kitchen());

-- 6) El inventario sigue a las ollas (alta, corrección y borrado)
create function public._batch_stock() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if current_setting('app.purging', true) = '1' then return coalesce(new, old); end if;
  begin
    if tg_op = 'INSERT' then
      insert into stock(salsa_id, qty) values (new.salsa_id, new.qty)
      on conflict (salsa_id) do update set qty = stock.qty + excluded.qty;
      return new;
    elsif tg_op = 'UPDATE' then
      if new.salsa_id = old.salsa_id then
        update stock set qty = qty + (new.qty - old.qty) where salsa_id = new.salsa_id;   -- solo la diferencia
      else
        update stock set qty = qty - old.qty where salsa_id = old.salsa_id;
        insert into stock(salsa_id, qty) values (new.salsa_id, new.qty)
        on conflict (salsa_id) do update set qty = stock.qty + excluded.qty;
      end if;
      return new;
    else
      update stock set qty = qty - old.qty where salsa_id = old.salsa_id;
      return old;
    end if;
  exception when check_violation then
    raise exception 'No se puede: esos tamales ya se usaron en pedidos listos o entregados.';
  end;
end $$;
create trigger trg_batch_stock after insert or update or delete on public.batches for each row execute function public._batch_stock();

-- Funciones internas (nadie puede llamarlas desde el navegador)
create function public._snapshot_order(p_order bigint) returns void language plpgsql security definer set search_path = public as $$
begin
  delete from order_tamales where order_id = p_order;
  insert into order_tamales(order_id, salsa_id, qty)
  select p_order, x.salsa_id, sum(x.q)::int from (
    select p.salsa_id, oi.qty::bigint as q from order_items oi join products p on p.id = oi.product_id
      where oi.order_id = p_order and not p.is_combo
    union all
    select p2.salsa_id, (oi.qty * ci.qty)::bigint from order_items oi
      join products c on c.id = oi.product_id and c.is_combo
      join combo_items ci on ci.combo_id = c.id join products p2 on p2.id = ci.product_id
      where oi.order_id = p_order
  ) x where x.salsa_id is not null group by x.salsa_id;
end $$;

create function public._debit_order(p_order bigint) returns void language plpgsql security definer set search_path = public as $$
declare r record; have int;
begin
  if (select stock_debited from orders where id = p_order) then return; end if;
  for r in select ot.salsa_id, ot.qty, c.name from order_tamales ot join categories c on c.id = ot.salsa_id
           where ot.order_id = p_order order by ot.salsa_id loop
    select qty into have from stock where salsa_id = r.salsa_id for update;
    have := coalesce(have, 0);
    if have < r.qty then
      raise exception 'Faltan tamales de %: hay %, el pedido necesita %. Registra la olla en Cocina.', r.name, have, r.qty;
    end if;
  end loop;
  update stock s set qty = s.qty - ot.qty from order_tamales ot where ot.order_id = p_order and s.salsa_id = ot.salsa_id;
  update orders set stock_debited = true where id = p_order;
end $$;

create function public._credit_order(p_order bigint) returns void language plpgsql security definer set search_path = public as $$
begin
  if not (select stock_debited from orders where id = p_order) then return; end if;
  insert into stock(salsa_id, qty) select salsa_id, qty from order_tamales where order_id = p_order
  on conflict (salsa_id) do update set qty = stock.qty + excluded.qty;
  update orders set stock_debited = false where id = p_order;
end $$;

create function public._add_items(p_order bigint, p_items jsonb) returns numeric language plpgsql security definer set search_path = public as $$
declare it jsonb; pr products%rowtype; q int; tot numeric := 0;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 50 then raise exception 'El pedido no tiene productos'; end if;
  for it in select * from jsonb_array_elements(p_items) loop
    q := (it->>'qty')::int;
    select * into pr from products where id = (it->>'product_id')::bigint and active;
    if not found or q is null or q not between 1 and 1000 then raise exception 'Producto o cantidad inválidos (¿un producto oculto?)'; end if;
    if pr.is_combo and not exists (select 1 from combo_items where combo_id = pr.id) then raise exception 'El combo "%" no tiene tamales', pr.name; end if;
    insert into order_items(order_id, product_id, qty, unit_price) values (p_order, pr.id, q, pr.price);
    tot := tot + pr.price * q;
  end loop;
  return round(tot, 2);
end $$;

revoke execute on function public._snapshot_order(bigint), public._debit_order(bigint), public._credit_order(bigint), public._add_items(bigint, jsonb)
  from public, anon, authenticated;

-- Al borrar un pedido pendiente-listo, sus tamales regresan al inventario
create function public._order_before_delete() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.stock_debited and old.status not in ('entregado','cancelado') then
    insert into stock(salsa_id, qty) select salsa_id, qty from order_tamales where order_id = old.id
    on conflict (salsa_id) do update set qty = stock.qty + excluded.qty;
  end if;
  return old;
end $$;
create trigger trg_order_before_delete before delete on public.orders for each row execute function public._order_before_delete();

-- 7) Funciones que usa la página
drop function public.create_order(bigint, text, text, jsonb, numeric, text);
drop function public.add_payment(bigint, numeric, text);

create function public.create_order(p_customer bigint, p_kind text, p_note text, p_items jsonb, p_tendered numeric, p_method text, p_deliver boolean)
returns bigint language plpgsql security definer set search_path = public as $$
declare oid bigint; tot numeric(10,2); v numeric(10,2) := round(coalesce(p_tendered, 0), 2); applied numeric(10,2) := 0;
begin
  if not can_cash() then raise exception 'No tienes permiso para registrar compras'; end if;
  if p_kind not in ('mostrador','envio','apartado') then raise exception 'Tipo de pedido inválido'; end if;
  if p_customer is not null and not exists (select 1 from customers where id = p_customer) then raise exception 'El cliente no existe'; end if;
  if p_kind in ('envio','apartado') and p_customer is null then raise exception 'Un % necesita cliente', p_kind; end if;
  if v < 0 then raise exception 'Monto inválido'; end if;
  insert into orders(customer_id, kind, delivery, total, note)
  values (p_customer, p_kind, case when p_kind = 'envio' then 'por_enviar' end, 0, left(nullif(trim(p_note), ''), 200))
  returning id into oid;
  tot := _add_items(oid, p_items);
  update orders set total = tot where id = oid;
  perform _snapshot_order(oid);
  if v > 0 and tot > 0 then
    if p_method is null or p_method not in ('efectivo','transferencia','tarjeta') then raise exception 'Método de pago inválido'; end if;
    if p_method <> 'efectivo' and v > tot then raise exception 'Solo en efectivo se puede dar cambio'; end if;
    applied := least(v, tot);
    insert into payments(order_id, amount, method, tendered) values (oid, applied, p_method, v);
  end if;
  if p_kind = 'mostrador' and coalesce(p_deliver, false) then
    if applied < tot then raise exception 'Para entregar en mostrador el pago debe estar completo'; end if;
    perform _debit_order(oid);
    update orders set status = 'entregado' where id = oid;
  end if;
  return oid;
end $$;

create function public.update_order(p_order bigint, p_customer bigint, p_kind text, p_note text, p_items jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare o orders%rowtype; tot numeric(10,2); paid numeric;
begin
  if not can_cash() then raise exception 'No tienes permiso para editar pedidos'; end if;
  select * into o from orders where id = p_order for update;
  if not found or o.status in ('cancelado','entregado') then raise exception 'Este pedido ya no se puede editar'; end if;
  if o.stock_debited then raise exception 'El pedido ya está listo. Regrésalo a pendiente para editarlo.'; end if;
  if p_kind not in ('mostrador','envio','apartado') then raise exception 'Tipo de pedido inválido'; end if;
  if p_customer is not null and not exists (select 1 from customers where id = p_customer) then raise exception 'El cliente no existe'; end if;
  if p_kind in ('envio','apartado') and p_customer is null then raise exception 'Un % necesita cliente', p_kind; end if;
  if o.delivery = 'en_camino' and p_kind <> 'envio' then raise exception 'El pedido ya va en camino'; end if;
  delete from order_items where order_id = p_order;
  tot := _add_items(p_order, p_items);
  select coalesce(sum(amount), 0) into paid from payments where order_id = p_order;
  if tot < paid then raise exception 'El nuevo total (%) es menor a lo ya abonado (%). Pide al administrador ajustar los abonos.', tot, paid; end if;
  update orders set customer_id = p_customer, kind = p_kind, total = tot, note = left(nullif(trim(p_note), ''), 200),
    delivery = case when p_kind = 'envio' then coalesce(o.delivery, 'por_enviar') else null end
  where id = p_order;
  perform _snapshot_order(p_order);
end $$;

create function public.add_payment(p_order bigint, p_tendered numeric, p_method text)
returns numeric language plpgsql security definer set search_path = public as $$
declare o orders%rowtype; paid numeric; owed numeric; v numeric(10,2) := round(coalesce(p_tendered, 0), 2); applied numeric(10,2);
begin
  select * into o from orders where id = p_order for update;
  if not found or o.status = 'cancelado' then raise exception 'Pedido no disponible'; end if;
  if not (can_cash() or (my_cargo() = 'repartidor' and o.kind = 'envio')) then raise exception 'No tienes permiso para cobrar'; end if;
  select coalesce(sum(amount), 0) into paid from payments where order_id = p_order;
  owed := o.total - paid;
  if owed <= 0 then raise exception 'Este pedido ya está pagado'; end if;
  if v <= 0 then raise exception 'Monto inválido'; end if;
  if p_method is null or p_method not in ('efectivo','transferencia','tarjeta') then raise exception 'Método de pago inválido'; end if;
  if p_method <> 'efectivo' and v > owed then raise exception 'Solo en efectivo se puede dar cambio'; end if;
  applied := least(v, owed);
  insert into payments(order_id, amount, method, tendered) values (p_order, applied, p_method, v);
  return v - applied;   -- cambio a devolver
end $$;

create or replace function public.set_order_status(p_order bigint, p_status text, p_delivery text) returns void
language plpgsql security definer set search_path = public as $$
declare o orders%rowtype; cg text := my_cargo(); adm boolean := is_admin(); saldo numeric; new_del text;
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
  if p_status = 'entregado' then
    saldo := o.total - coalesce((select sum(amount) from payments where order_id = p_order), 0);
    if saldo > 0.001 then raise exception 'Aún hay saldo por cobrar (%). Registra el pago antes de entregar.', saldo; end if;
  end if;
  if p_status in ('listo','entregado') then perform _debit_order(p_order); else perform _credit_order(p_order); end if;
  if o.kind = 'envio' then
    if p_status = 'entregado' then new_del := 'entregado';
    else new_del := coalesce(p_delivery, case when o.delivery = 'entregado' then 'por_enviar' else o.delivery end);
    end if;
  end if;
  update orders set status = p_status, delivery = new_del where id = p_order;
end $$;

create or replace function public.cancel_order(p_order bigint) returns void
language plpgsql security definer set search_path = public as $$
declare o orders%rowtype;
begin
  if not is_admin() then raise exception 'Solo el administrador puede cancelar'; end if;
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'Pedido no existe'; end if;
  if o.status not in ('entregado','cancelado') then perform _credit_order(p_order); end if;
  update orders set status = 'cancelado' where id = p_order;
end $$;

create or replace function public.close_cash() returns cash_closures
language plpgsql security definer set search_path = public as $$
declare f timestamptz; r cash_closures;
begin
  if not can_cash() then raise exception 'Sin permiso'; end if;
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

-- Guardar tamal o combo (atómico, solo admin)
create function public.save_product(p_id bigint, p_name text, p_desc text, p_price numeric, p_salsa bigint, p_combo boolean, p_items jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare pid bigint; it jsonb;
begin
  if not is_admin() then raise exception 'Solo el administrador'; end if;
  if char_length(trim(coalesce(p_name,''))) < 2 then raise exception 'Escribe el nombre'; end if;
  if p_price is null or p_price < 0 or p_price > 100000 then raise exception 'Precio inválido'; end if;
  if not coalesce(p_combo, false) and p_salsa is null then raise exception 'Elige el sabor del tamal'; end if;
  if p_id is null then
    insert into products(name, description, price, salsa_id, is_combo)
    values (trim(p_name), nullif(trim(p_desc), ''), round(p_price, 2), case when p_combo then null else p_salsa end, coalesce(p_combo, false))
    returning id into pid;
  else
    update products set name = trim(p_name), description = nullif(trim(p_desc), ''), price = round(p_price, 2),
      salsa_id = case when is_combo then null else p_salsa end
    where id = p_id returning id into pid;
    if pid is null then raise exception 'El producto no existe'; end if;
  end if;
  if (select is_combo from products where id = pid) then
    if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 30 then raise exception 'Un combo necesita al menos un tamal'; end if;
    delete from combo_items where combo_id = pid;
    for it in select * from jsonb_array_elements(p_items) loop
      insert into combo_items(combo_id, product_id, qty) values (pid, (it->>'product_id')::bigint, (it->>'qty')::int);
    end loop;
  end if;
  return pid;
end $$;

-- Notificaciones de contraseña: marcar como atendidas / descartar
create function public.resolve_reset(p_user uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Solo el administrador'; end if;
  update reset_requests set handled = true where user_id = p_user and not handled;
end $$;

-- Resumen para la pantalla Tamales: disponibles vs por surtir
create function public.tamales_resumen() returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('salsa_id', c.id, 'name', c.name, 'stock', coalesce(s.qty, 0), 'pendiente', coalesce(d.q, 0)) order by c.name), '[]'::jsonb)
  from categories c
  left join stock s on s.salsa_id = c.id
  left join (select ot.salsa_id, sum(ot.qty) as q from order_tamales ot join orders o on o.id = ot.order_id
             where o.status = 'pendiente' and not o.stock_debited group by ot.salsa_id) d on d.salsa_id = c.id
  where is_active() and c.kind = 'salsa'
$$;

-- Almacenamiento: ahora incluye las imágenes
create or replace function public.db_usage() returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not is_admin() then raise exception 'Solo el administrador'; end if;
  return jsonb_build_object(
    'bytes', pg_database_size(current_database()),
    'storage', (select coalesce(sum((metadata->>'size')::bigint), 0) from storage.objects),
    'tables', (select coalesce(jsonb_object_agg(c.relname::text, pg_total_relation_size(c.oid)), '{}'::jsonb)
               from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'));
end $$;

create or replace function public.purge_data(p_target text, p_days int) returns int
language plpgsql security definer set search_path = public as $$
declare n int := 0;
begin
  if not is_admin() then raise exception 'Solo el administrador'; end if;
  if p_days is null or p_days < 30 then raise exception 'Mínimo 30 días'; end if;
  if p_target = 'ollas' then
    perform set_config('app.purging', '1', true);   -- borrar historial NO descuenta el inventario actual
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

-- 8) Imágenes del catálogo (JPG de máximo ~100 KB, solo el admin sube)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('catalogo', 'catalogo', true, 100000, array['image/jpeg']) on conflict (id) do nothing;
create policy cat_img_sel on storage.objects for select using (bucket_id = 'catalogo');
create policy cat_img_ins on storage.objects for insert to authenticated with check (bucket_id = 'catalogo' and public.is_admin());
create policy cat_img_del on storage.objects for delete to authenticated using (bucket_id = 'catalogo' and public.is_admin());

alter publication supabase_realtime add table public.stock;
