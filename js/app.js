'use strict';

const sb = supabase.createClient(APP_CONFIG.SUPABASE_URL, APP_CONFIG.SUPABASE_ANON_KEY);
const app = document.getElementById('app');
const st = { me:null, cats:[], batches:[], salsa:null, view:'cocina', users:[], draft:{} };

// Construcción de DOM sin innerHTML: el texto de usuarios nunca se interpreta como HTML (anti-XSS)
function h(tag, cls, txt, kids){ const e=document.createElement(tag); if(cls) e.className=cls; if(txt!=null) e.textContent=txt; (kids||[]).forEach(k=>e.append(k)); return e; }
const ic = n => h('i','bi bi-'+n+' me-1');
const isAdmin = () => st.me && ['master','administrador'].includes(st.me.role);

function toast(msg, ok=true){
  const t=h('div','position-fixed top-0 start-50 translate-middle-x mt-3 px-3 py-2 rounded text-white '+(ok?'bg-success':'bg-danger'),null,[ic(ok?'check-circle':'exclamation-triangle'),msg]);
  t.style.zIndex=3000; document.body.append(t); setTimeout(()=>t.remove(),3000);
}
// Confirmación animada obligatoria antes de cualquier cambio
function confirmar(msg){
  return new Promise(res=>{
    const ov=h('div','ov'); const key=e=>{if(e.key==='Escape')done(false)}; const done=v=>{document.removeEventListener('keydown',key);ov.remove();res(v)}; document.addEventListener('keydown',key);
    const yes=h('button','btn btn-acc px-4','Sí, continuar'); yes.onclick=()=>done(true);
    const no=h('button','btn btn-outline-secondary px-4','Cancelar'); no.onclick=()=>done(false);
    const ico=h('i','bi bi-question-circle acc'); ico.style.fontSize='3rem';
    ov.append(h('div','box',null,[ico,h('p','fs-5 my-3',msg),h('div','d-flex gap-2 justify-content-center',null,[no,yes])]));
    document.body.append(ov); yes.focus();
  });
}
// Encapsula errores: el usuario ve un mensaje claro, el detalle va a consola
async function seguro(fn){ try{ await fn(); }catch(e){ console.error(e); toast(e&&e.msg?e.msg:'No se pudo completar. Revisa tu conexión o permisos.',false); } }

/* ---------- Sesión ---------- */
async function boot(){
  const {data:{session}} = await sb.auth.getSession();
  if(!session) return loginView();
  const {data:p,error} = await sb.from('profiles').select('*').eq('id',session.user.id).single();
  if(error || !p || !p.active){ await sb.auth.signOut(); loginView('Tu cuenta no está activa. Habla con el administrador.'); return; }
  st.me = p; if(p.must_change) return cambiarClaveView();
  const th = localStorage.getItem('tema')||'claro'; setTheme(th);
  await loadAll(); subscribe(); render();
}
function loginView(msg){
  app.replaceChildren();
  const email=h('input','form-control mb-2'); email.type='email'; email.placeholder='Correo'; email.autocomplete='username'; email.maxLength=120;
  const pw=h('input','form-control mb-3'); pw.type='password'; pw.placeholder='Contraseña'; pw.autocomplete='current-password'; pw.maxLength=72;
  const err=h('div','text-danger small mb-2',msg||'');
  const btn=h('button','btn btn-acc w-100',null,[ic('box-arrow-in-right'),'Entrar']);
  let tries=0;
  btn.onclick=()=>seguro(async()=>{
    if(!/^\S+@\S+\.\S+$/.test(email.value)||pw.value.length<8){err.textContent='Escribe un correo válido y tu contraseña.';return;}
    if(++tries>5){err.textContent='Demasiados intentos. Espera un minuto.';setTimeout(()=>tries=0,60000);return;}
    btn.disabled=true;
    const {error}=await sb.auth.signInWithPassword({email:email.value.trim(),password:pw.value});
    btn.disabled=false;
    if(error){err.textContent='Correo o contraseña incorrectos.';return;}
    boot();
  });
  pw.onkeydown=e=>{if(e.key==='Enter')btn.click()};
  const logo=h('i','bi bi-fire acc'); logo.style.fontSize='3rem';
  app.append(h('div','card p-4 mx-auto mt-5 shadow',null,[h('div','text-center mb-3',null,[logo,h('h3','mt-2','Tamales')]),email,pw,err,btn]));
}

/* ---------- Datos y tiempo real ---------- */
async function loadAll(){
  const d=new Date(); d.setHours(0,0,0,0);
  const [c,b]=await Promise.all([
    sb.from('categories').select('*').order('kind').order('value',{nullsFirst:false}).order('name'),
    sb.from('batches').select('id,qty,created_at,salsa_id').gte('created_at',d.toISOString()).order('created_at',{ascending:false}).limit(1000)
  ]);
  if(c.error||b.error) throw (c.error||b.error);
  st.cats=c.data; st.batches=b.data;
  if(isAdmin()){ const u=await sb.from('profiles').select('id,full_name,email,role,active').order('full_name'); if(u.error) throw u.error; st.users=u.data; }
}
let ch;
function subscribe(){
  if(ch) sb.removeChannel(ch);
  ch=sb.channel('live').on('postgres_changes',{event:'*',schema:'public'},()=>seguro(async()=>{await loadAll(); if(st.view!=='cocina') render();})).subscribe();
}
const byKind = k => st.cats.filter(c=>c.kind===k);
const salsaName = id => (st.cats.find(c=>c.id===id)||{}).name||'?';

/* ---------- Vistas ---------- */
function render(){
  app.replaceChildren();
  const tabs=[['cocina','fire','Cocina'],['dashboard','speedometer2','Hoy']]; if(isAdmin()) tabs.push(['cats','tags','Categorías'],['users','people','Usuarios']);
  const nav=h('div','d-flex flex-wrap gap-2 mb-3 align-items-center',null,tabs.map(([v,i,l])=>{
    const b=h('button','chip'+(st.view===v?' on':''),null,[ic(i),l]); b.onclick=()=>{st.view=v;render()}; return b;}));
  const th=h('select','form-select form-select-sm ms-auto w-auto');
  [['claro','Claro'],['oscuro','Oscuro'],['muertos','Día de Muertos'],['patrio','Fiestas Patrias'],['navidad','Navidad']].forEach(([v,l])=>{const o=h('option',null,l);o.value=v;th.append(o)});
  th.value=document.documentElement.dataset.theme; th.onchange=()=>setTheme(th.value);
  const out=h('button','btn btn-sm btn-outline-secondary',null,[ic('box-arrow-right'),'Salir']);
  out.onclick=async()=>{if(await confirmar('¿Cerrar sesión?')){await sb.auth.signOut();st.me=null;loginView();}};
  nav.append(th,out);
  app.append(h('div','mb-2 text-secondary',null,[ic('person-circle'),st.me.full_name+' · '+st.me.role]),nav,
    st.view==='cocina'?cocina():st.view==='dashboard'?dashboard():st.view==='users'?usuarios():cats());
}
function setTheme(t){ const r=document.documentElement; r.dataset.theme=t; r.dataset.bsTheme=['oscuro','muertos','navidad'].includes(t)?'dark':'light'; localStorage.setItem('tema',t); }

function cocina(){
  const box=h('div','card p-3');
  box.append(h('h5',null,'¿De qué salsa salió la olla?'));
  const salsas=byKind('salsa');
  if(!salsas.length) box.append(h('p','text-secondary','Aún no hay salsas. Pídele al administrador que las agregue en Categorías.'));
  box.append(h('div','d-flex flex-wrap gap-2 mb-3',null,salsas.map(s=>{
    const b=h('button','chip'+(st.salsa===s.id?' on':''),s.name); b.onclick=()=>{st.salsa=s.id;render()}; return b;})));
  box.append(h('h5',null,'¿Cuántos salieron?'));
  const guardar=q=>seguro(async()=>{
    q=Number(q);
    if(!st.salsa) return toast('Primero elige la salsa.',false);
    if(!Number.isInteger(q)||q<1||q>500) return toast('La cantidad debe ser un número entero de 1 a 500.',false);
    if(!await confirmar(`¿Registrar ${q} tamales de ${salsaName(st.salsa)}?`)) return;
    const {error}=await sb.from('batches').insert({salsa_id:st.salsa,qty:q}); if(error) throw error;
    toast('Registrado'); st.salsa=null; st.draft.custom=''; render();
  });
  box.append(h('div','d-flex flex-wrap gap-2 mb-3',null,byKind('cantidad').map(c=>{
    const b=h('button','btn btn-acc btn-lg',String(c.value)); b.onclick=()=>guardar(c.value); return b;})));
  const n=h('input','form-control'); n.type='number'; n.min=1; n.max=500; n.step=1; n.inputMode='numeric'; n.placeholder='Otra cantidad'; n.value=st.draft.custom||''; n.oninput=()=>{st.draft.custom=n.value};
  const go=h('button','btn btn-outline-secondary',null,[ic('pencil'),'Personalizar']); go.onclick=()=>guardar(n.value);
  box.append(h('div','input-group',null,[n,go]));
  return box;
}

function dashboard(){
  const total=st.batches.reduce((a,b)=>a+b.qty,0), per={};
  st.batches.forEach(b=>per[b.salsa_id]=(per[b.salsa_id]||0)+b.qty);
  const wrap=h('div');
  wrap.append(h('div','card p-3 mb-3 text-center',null,[h('div','big',String(total)),h('div',null,'tamales hoy')]));
  const row=h('div','row g-2 mb-3');
  byKind('salsa').forEach(s=>row.append(h('div','col-6 col-md-3',null,[h('div','card p-2 text-center',null,[h('div','fs-3 fw-bold',String(per[s.id]||0)),h('small',null,s.name)])])));
  wrap.append(row,h('h6',null,'Últimas ollas'));
  if(!st.batches.length) wrap.append(h('p','text-secondary','Todavía no hay ollas registradas hoy.'));
  st.batches.slice(0,15).forEach(b=>{
    const row=h('div','card p-2 mb-2 d-flex flex-row align-items-center',null,[
      h('span','flex-grow-1',`${new Date(b.created_at).toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit'})} · ${b.qty} de ${salsaName(b.salsa_id)}`)]);
    if(isAdmin()){ const d=h('button','btn btn-sm btn-outline-danger',null,[ic('trash')]); d.title='Eliminar registro';
      d.onclick=()=>seguro(async()=>{ if(!await confirmar('¿Eliminar este registro? No se puede deshacer.'))return;
        const {error}=await sb.from('batches').delete().eq('id',b.id); if(error)throw error; toast('Eliminado'); }); row.append(d); }
    wrap.append(row);
  });
  return wrap;
}

function cats(){
  const wrap=h('div');
  [['salsa','Salsas'],['cantidad','Botones de cantidad'],['rol_trabajador','Roles de trabajador'],['sucursal','Sucursales']].forEach(([kind,title])=>{
    const box=h('div','card p-3 mb-3'); box.append(h('h6',null,title));
    byKind(kind).forEach(c=>{
      const d=h('button','btn btn-sm btn-outline-danger ms-2',null,[h('i','bi bi-x-lg')]); d.title='Eliminar';
      d.onclick=()=>seguro(async()=>{ if(!await confirmar(`¿Eliminar "${c.name}"?`))return;
        const {error}=await sb.from('categories').delete().eq('id',c.id);
        if(error) return toast('No se puede eliminar: ya tiene registros asociados.',false); toast('Eliminado'); });
      box.append(h('span','d-inline-flex align-items-center me-2 mb-2 chip',c.name,[d]));
    });
    const inp=h('input','form-control'); inp.maxLength=50; inp.placeholder='Nuevo…'; inp.value=st.draft[kind]||''; inp.oninput=()=>{st.draft[kind]=inp.value};
    const add=h('button','btn btn-acc',null,[ic('plus-lg'),'Agregar']);
    add.onclick=()=>seguro(async()=>{
      const name=inp.value.trim().replace(/\s+/g,' '); let value=null;
      if(!name) return toast('Escribe un nombre.',false);
      if(kind==='cantidad'){ value=Number(name); if(!Number.isInteger(value)||value<1||value>500) return toast('Escribe un número de 1 a 500.',false); }
      if(byKind(kind).some(c=>c.name.toLowerCase()===name.toLowerCase())) return toast('Ya existe.',false);
      if(!await confirmar(`¿Agregar "${name}"?`)) return;
      const {error}=await sb.from('categories').insert({kind,name,value}); if(error) throw error; st.draft[kind]=''; toast('Agregado');
    });
    box.append(h('div','input-group',null,[inp,add])); wrap.append(box);
  });
  return wrap;
}


/* ---------- Usuarios (requiere la Edge Function admin-users) ---------- */
async function llamar(body){
  const {data,error}=await sb.functions.invoke('admin-users',{body});
  if(error){ let m='No se pudo completar.'; try{ m=(await error.context.json()).error||m }catch{} const e=new Error(m); e.msg=m; throw e; }
  return data;
}
function mostrarClave(pw){
  const ov=h('div','ov'); const i=h('input','form-control text-center fs-5 mb-3'); i.value=pw; i.readOnly=true;
  const ok=h('button','btn btn-acc',null,[ic('check-lg'),'Ya la copié']); ok.onclick=()=>ov.remove();
  ov.append(h('div','box',null,[h('p','fw-bold','Contraseña temporal: se muestra una sola vez'),i,h('p','small','La persona deberá cambiarla al entrar.'),ok]));
  document.body.append(ov); i.select();
}
function usuarios(){
  const wrap=h('div'), box=h('div','card p-3 mb-3'); box.append(h('h6',null,'Nuevo usuario'));
  const nm=h('input','form-control mb-2'); nm.placeholder='Nombre completo'; nm.maxLength=80;
  const em=h('input','form-control mb-2'); em.type='email'; em.placeholder='Correo'; em.maxLength=120;
  const rl=h('select','form-select mb-2');
  [['usuario','Usuario'],['administrador','Administrador'],['master','Master']].filter(r=>r[0]!=='master'||st.me.role==='master').forEach(([v,l])=>{const o=h('option',null,l);o.value=v;rl.append(o)});
  const add=h('button','btn btn-acc',null,[ic('person-plus'),'Crear usuario']);
  add.onclick=()=>seguro(async()=>{
    if(nm.value.trim().length<2||!/^\S+@\S+\.\S+$/.test(em.value.trim())) return toast('Escribe un nombre y un correo válidos.',false);
    if(!await confirmar(`¿Crear a ${nm.value.trim()} como ${rl.value}?`)) return;
    const r=await llamar({action:'create',full_name:nm.value.trim(),email:em.value.trim(),role:rl.value});
    await loadAll(); render(); mostrarClave(r.password);
  });
  box.append(nm,em,rl,add); wrap.append(box);
  st.users.forEach(u=>{
    const locked=u.id===st.me.id||(u.role==='master'&&st.me.role!=='master');
    const row=h('div','card p-2 mb-2 d-flex flex-row align-items-center gap-2',null,[h('span','flex-grow-1',`${u.full_name} · ${u.role}${u.active?'':' · deshabilitado'}`)]);
    if(!locked){
      const rs=h('button','btn btn-sm btn-outline-secondary',null,[ic('key')]); rs.title='Restablecer contraseña';
      rs.onclick=()=>seguro(async()=>{ if(!await confirmar(`¿Restablecer la contraseña de ${u.full_name}?`))return; const r=await llamar({action:'reset_password',user_id:u.id}); mostrarClave(r.password); });
      const tg=h('button','btn btn-sm btn-outline-'+(u.active?'danger':'success'),null,[ic(u.active?'person-x':'person-check')]); tg.title=u.active?'Deshabilitar':'Habilitar';
      tg.onclick=()=>seguro(async()=>{ if(!await confirmar(u.active?`¿Deshabilitar a ${u.full_name}?`:`¿Habilitar a ${u.full_name}?`))return; await llamar({action:'set_active',user_id:u.id,active:!u.active}); await loadAll(); render(); toast('Listo'); });
      row.append(rs,tg);
    }
    wrap.append(row);
  });
  return wrap;
}
function cambiarClaveView(){
  app.replaceChildren();
  const a=h('input','form-control mb-2'); a.type='password'; a.placeholder='Nueva contraseña (mínimo 10)'; a.autocomplete='new-password'; a.maxLength=72;
  const b=h('input','form-control mb-3'); b.type='password'; b.placeholder='Repítela'; b.autocomplete='new-password'; b.maxLength=72;
  const go=h('button','btn btn-acc w-100','Guardar contraseña');
  go.onclick=()=>seguro(async()=>{
    if(a.value.length<10||!/[a-z]/.test(a.value)||!/[A-Z]/.test(a.value)||!/\d/.test(a.value)) return toast('Mínimo 10 caracteres, con mayúscula, minúscula y número.',false);
    if(a.value!==b.value) return toast('Las contraseñas no coinciden.',false);
    const {error}=await sb.auth.updateUser({password:a.value}); if(error) throw error;
    const r=await sb.rpc('clear_must_change'); if(r.error) throw r.error;
    toast('Contraseña actualizada'); boot();
  });
  app.append(h('div','card p-4 mx-auto mt-5',null,[h('h5',null,'Crea tu contraseña nueva'),h('p','small','Es obligatoria antes de continuar.'),a,b,go]));
}

sb.auth.onAuthStateChange(e=>{ if(e==='SIGNED_OUT'){ st.me=null; loginView(); } });
boot();
