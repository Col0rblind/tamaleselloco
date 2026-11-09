import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const ROLES = ["master", "administrador", "usuario"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tempPassword = () => {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const a = crypto.getRandomValues(new Uint32Array(14));
  return Array.from(a, (n) => c[n % c.length]).join("") + "A#7";
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    // 1) Quién llama: se valida el JWT que manda el navegador
    const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await caller.auth.getUser();
    if (!user) return json({ error: "Sesión no válida" }, 401);

    // 2) Cliente con poder total: SOLO vive aquí, en el servidor
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: me } = await admin.from("profiles").select("role,active,must_change").eq("id", user.id).single();
    if (!me?.active || me.must_change || !["master", "administrador"].includes(me.role)) {
      return json({ error: "No tienes permiso para esto" }, 403);
    }

    const b = await req.json();
    const isMaster = me.role === "master";

    // Carga y valida al usuario objetivo
    const target = async () => {
      if (!UUID.test(b.user_id ?? "")) throw new Error("Usuario inválido");
      if (b.user_id === user.id) throw new Error("No puedes hacerlo sobre tu propia cuenta");
      const { data: t } = await admin.from("profiles").select("id,role").eq("id", b.user_id).single();
      if (!t) throw new Error("Usuario no encontrado");
      if (t.role === "master" && !isMaster) throw new Error("Solo un master puede gestionar a un master");
      return t;
    };

    if (b.action === "create") {
      const name = String(b.full_name ?? "").trim().replace(/\s+/g, " ");
      const email = String(b.email ?? "").trim().toLowerCase();
      if (name.length < 2 || name.length > 80) throw new Error("Nombre inválido");
      if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 120) throw new Error("Correo inválido");
      if (!ROLES.includes(b.role)) throw new Error("Rol inválido");
      if (b.role === "master" && !isMaster) throw new Error("Solo un master puede crear otro master");
      const password = tempPassword();
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (error) throw new Error("No se pudo crear (¿el correo ya existe?)");
      const { error: pe } = await admin.from("profiles").insert({
        id: data.user.id, full_name: name, email, role: b.role, must_change: true,
      });
      if (pe) { await admin.auth.admin.deleteUser(data.user.id); throw new Error("No se pudo crear el perfil"); }
      return json({ ok: true, password });
    }

    if (b.action === "reset_password") {
      const t = await target();
      const password = tempPassword();
      const { error } = await admin.auth.admin.updateUserById(t.id, { password });
      if (error) throw new Error("No se pudo restablecer");
      await admin.from("profiles").update({ must_change: true }).eq("id", t.id);
      return json({ ok: true, password });
    }

    if (b.action === "set_active") {
      const t = await target();
      if (typeof b.active !== "boolean") throw new Error("Valor inválido");
      await admin.from("profiles").update({ active: b.active }).eq("id", t.id);
      // Además se bloquea en Auth: no podrá iniciar sesión nueva
      await admin.auth.admin.updateUserById(t.id, { ban_duration: b.active ? "none" : "876000h" });
      return json({ ok: true });
    }

    return json({ error: "Acción desconocida" }, 400);
  } catch (e) {
    // Los errores nuestros (Error) se muestran; cualquier otro detalle interno no se filtra
    console.error(e);
    return json({ error: e instanceof Error ? e.message : "Error interno" }, 400);
  }
});
