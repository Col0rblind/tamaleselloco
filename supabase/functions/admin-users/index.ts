import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": Deno.env.get("ALLOWED_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

const DOMAIN = Deno.env.get("EMAIL_DOMAIN") ?? "tamales.local";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const rnd = (n: number) => crypto.getRandomValues(new Uint32Array(1))[0] % n;
const tempPassword = () => {
  // Garantiza mayúscula, minúscula, número y símbolo, para cumplir cualquier política de Auth
  const U = "ABCDEFGHJKLMNPQRSTUVWXYZ", L = "abcdefghijkmnpqrstuvwxyz", D = "23456789", S = "#$%&*+-=?";
  const pick = (s: string) => s[rnd(s.length)];
  const c = [pick(U), pick(L), pick(D), pick(S), ...Array.from({ length: 12 }, () => pick(U + L + D))];
  for (let i = c.length - 1; i > 0; i--) { const j = rnd(i + 1); [c[i], c[j]] = [c[j], c[i]]; }
  return c.join("");
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  try {
    const b = await req.json().catch(() => ({}));
    // Pregunta de versión: no revela nada y sirve para comprobar que se desplegó el código nuevo
    if (b.action === "version") return json({ ok: true, version: 6 });
    const url = Deno.env.get("SUPABASE_URL")!;
    // 1) Quién llama: se valida el JWT que manda el navegador
    const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await caller.auth.getUser();
    if (!user) return json({ error: "Sesión no válida" }, 401);

    // 2) Cliente con poder total: SOLO vive aquí, en el servidor
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: me } = await admin.from("profiles").select("role,active,must_change,full_name").eq("id", user.id).single();
    if (!me?.active || me.must_change || !["master", "administrador"].includes(me.role)) {
      return json({ error: "No tienes permiso para esto" }, 403);
    }

    const isMaster = me.role === "master";
    // Cada acción administrativa queda en la Matriz con quién la hizo
    const logA = async (action: string, id: string, detail: string) => {
      await admin.from("audit_log").insert({ user_id: user.id, user_name: me.full_name, action, entity: "usuario", entity_id: id, detail });
    };

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
      const username = String(b.username ?? "").trim().toLowerCase();
      if (name.length < 2 || name.length > 80) throw new Error("Nombre inválido");
      if (!/^[a-z0-9._]{3,20}$/.test(username)) throw new Error("Usuario inválido: 3 a 20 letras, números, punto o guion bajo");
      // Nadie puede crear un master desde la página: el master se crea solo por SQL
      if (!["administrador", "usuario"].includes(b.role)) throw new Error("Rol inválido");
      const cargo = b.role === "administrador" ? "general" : String(b.cargo ?? "");
      if (!["cajero", "repartidor", "cocinero", "general"].includes(cargo)) throw new Error("Cargo inválido");
      const phone = String(b.phone ?? "").replace(/\D/g, "");
      if (!/^[0-9]{10}$/.test(phone)) throw new Error("El celular debe tener 10 dígitos");
      const password = tempPassword();
      const email = `${username}@${DOMAIN}`;
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (error) {
        console.error("create_user:", error);
        if (/already|registered|exists/i.test(error.message)) throw new Error("Ese usuario ya existe");
        if (/email/i.test(error.message)) throw new Error(`Supabase rechazó el correo interno ${email}. EMAIL_DOMAIN debe ser igual en la función y en config.js.`);
        throw new Error("No se pudo crear: " + error.message);
      }
      const { error: pe } = await admin.from("profiles").insert({
        id: data.user.id, full_name: name, username, email, role: b.role, cargo, phone, must_change: true,
      });
      if (pe) {
        console.error("profile insert:", pe);
        await admin.auth.admin.deleteUser(data.user.id);
        throw new Error(pe.code === "23505" ? "Ese usuario ya existe" : "No se pudo crear el perfil: " + pe.message);
      }
      await logA("crear", data.user.id, `Creó al usuario @${username} (${b.role}${b.role === "administrador" ? "" : ", " + cargo})`);
      return json({ ok: true, password });
    }

    if (b.action === "reset_password") {
      const t = await target();
      const password = tempPassword();
      const { error } = await admin.auth.admin.updateUserById(t.id, { password });
      if (error) { console.error("reset_password:", error); throw new Error("No se pudo restablecer: " + error.message); }
      await admin.from("profiles").update({ must_change: true }).eq("id", t.id);
      await admin.from("reset_requests").update({ handled: true }).eq("user_id", t.id).eq("handled", false);
      await logA("restablecer_clave", t.id, "Restableció una contraseña (el usuario deberá cambiarla)");
      return json({ ok: true, password });
    }

    if (b.action === "set_active") {
      const t = await target();
      if (typeof b.active !== "boolean") throw new Error("Valor inválido");
      await admin.from("profiles").update({ active: b.active }).eq("id", t.id);
      // Además se bloquea en Auth: no podrá iniciar sesión nueva
      await admin.auth.admin.updateUserById(t.id, { ban_duration: b.active ? "none" : "876000h" });
      await logA(b.active ? "habilitar" : "deshabilitar", t.id, b.active ? "Habilitó una cuenta" : "Deshabilitó una cuenta");
      return json({ ok: true });
    }

    if (b.action === "update_profile") {
      const t = await target();
      const cargo = String(b.cargo ?? "");
      const phone = String(b.phone ?? "").replace(/\D/g, "");
      if (!["cajero", "repartidor", "cocinero", "general"].includes(cargo)) throw new Error("Cargo inválido");
      if (!/^[0-9]{10}$/.test(phone)) throw new Error("El celular debe tener 10 dígitos");
      const { error } = await admin.from("profiles").update({ cargo, phone }).eq("id", t.id);
      if (error) throw new Error("No se pudo actualizar");
      await logA("editar", t.id, `Cambió cargo a ${cargo} y celular`);
      return json({ ok: true });
    }

    return json({ error: "Acción desconocida" }, 400);
  } catch (e) {
    // Los errores nuestros (Error) se muestran; cualquier otro detalle interno no se filtra
    console.error(e);
    return json({ error: e instanceof Error ? e.message : "Error interno" }, 400);
  }
});
