-- ====================================================================
-- Migración para soportar deshabilitar categorías (salsas, cantidades, sucursales)
-- Ejecutar en Supabase Dashboard > SQL Editor
-- ====================================================================

-- 1) Agregar columna active con valor por defecto true
alter table public.categories add column if not exists active boolean not null default true;

-- 2) Asegurar que la suscripción a Realtime transmita la columna
alter publication supabase_realtime add table public.categories;
