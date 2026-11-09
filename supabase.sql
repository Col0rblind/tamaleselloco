-- Ejecutar completo en Supabase > SQL Editor.
-- Antes: Authentication > Providers > Email: DESACTIVAR "Allow new users to sign up".

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null check (char_length(full_name) between 2 and 80),
  role text not null default 'usuario' check (role in ('master','administrador','usuario')),
  email text,
  active boolean not null default true,
  must_change boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.categories (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('salsa','cantidad','rol_trabajador','sucursal')),
  name text not null check (char_length(name) between 1 and 50),
  value int check (value is null or value between 1 and 500),
  unique (kind, name),
  check ((kind = 'cantidad') = (value is not null))
);

create table public.batches (
  id bigint generated always as identity primary key,
  salsa_id bigint not null references public.categories(id) on delete restrict,
  qty int not null check (qty between 1 and 500),
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now()
);
create index on public.batches (created_at desc);

-- Funciones auxiliares (security definer evita recursión en RLS)
create function public.is_active() returns boolean language sql stable security definer set search_path = public as
$$ select coalesce((select active and not must_change from profiles where id = auth.uid()), false) $$;

create function public.is_admin() returns boolean language sql stable security definer set search_path = public as
$$ select coalesce((select active and not must_change and role in ('master','administrador') from profiles where id = auth.uid()), false) $$;

alter table public.profiles   enable row level security;
alter table public.categories enable row level security;
alter table public.batches    enable row level security;

-- profiles: cada quien ve el suyo; admin ve y edita todos (no se puede borrar desde el cliente)
create policy profiles_select on public.profiles for select to authenticated using (id = auth.uid() or public.is_admin());
-- Sin política de UPDATE/INSERT/DELETE en profiles: roles y estado SOLO cambian vía Edge Function (service_role).
-- Así un administrador no puede ascenderse a master desde el navegador.

-- categories: lectura para activos, escritura solo admin
create policy cat_select on public.categories for select to authenticated using (public.is_active());
create policy cat_write  on public.categories for all    to authenticated using (public.is_admin()) with check (public.is_admin());

-- batches: activos leen e insertan (solo a su nombre); solo admin corrige o elimina
create policy b_select on public.batches for select to authenticated using (public.is_active());
create policy b_insert on public.batches for insert to authenticated with check (public.is_active() and created_by = auth.uid());
create policy b_update on public.batches for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy b_delete on public.batches for delete to authenticated using (public.is_admin());

-- La salsa de una olla debe ser realmente una salsa
create function public.check_batch() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from categories where id = new.salsa_id and kind = 'salsa') then raise exception 'Salsa inválida'; end if;
  return new;
end $$;
create trigger trg_check_batch before insert or update on public.batches for each row execute function public.check_batch();

-- Único cambio que un usuario puede hacer en su perfil: quitar la marca de "cambiar contraseña"
create function public.clear_must_change() returns void language sql security definer set search_path = public as
$$ update profiles set must_change = false where id = auth.uid() $$;

-- Tiempo real
alter publication supabase_realtime add table public.batches, public.categories;

-- Datos iniciales
insert into public.categories (kind,name,value) values
 ('cantidad','30',30),('cantidad','60',60),('cantidad','90',90),
 ('salsa','Rojo',null),('salsa','Verde',null),('salsa','Rajas',null),('salsa','Dulce',null),
 ('rol_trabajador','Cocinero',null),('rol_trabajador','Repartidor',null),('rol_trabajador','Cajero',null);

-- PRIMER MASTER: 1) crea el usuario en Authentication > Users (con "Auto confirm"),
-- 2) copia su UUID y ejecuta:
-- insert into public.profiles (id, full_name, role) values ('UUID-AQUI','Tu nombre','master');
