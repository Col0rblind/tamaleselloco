'use strict';

const sb = supabase.createClient(APP_CONFIG.SUPABASE_URL, APP_CONFIG.SUPABASE_ANON_KEY);
const app = document.getElementById('app');
const st = { me:null, cats:[], batches:[], salsa:null, view:'cocina', users:[], resets:[], draft:{}, cart:null, range:'hoy' };

// Construcción de DOM sin innerHTML: el texto de usuarios nunca se interpreta como HTML (anti-XSS)
function h(tag, cls, txt, kids){ const e=document.createElement(tag); if(cls) e.className=cls; if(txt!=null) e.textContent=txt; (kids||[]).forEach(k=>e.append(k)); return e; }
const ic = n => h('i','bi bi-'+n+' me-1');
const isAdmin = () => st.me && ['master','administrador'].includes(st.me.role);

function toast(msg, ok=true){
  const t=h('div','position-fixed top-0 start-50 translate-middle-x mt-3 px-3 py-2 rounded text-white '+(ok?'bg-success':'bg-danger'),null,[ic(ok?'check-circle':'exclamation-triangle'),msg]);
  t.style.zIndex=3000; document.body.append(t); setTimeout(()=>t.remove(),msg.length>70?7000:3000);
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
  app.replaceChildren(); document.body.classList.add('login-bg');
  const user=h('input','form-control'); user.placeholder='Usuario'; user.autocomplete='username'; user.maxLength=20; user.autocapitalize='none'; user.spellcheck=false;
  const ug=h('div','input-group mb-3',null,[h('span','input-group-text',null,[h('i','bi bi-person')]),user]);
  const P=pwField('Contraseña','current-password'), pw=P.input; P.el.prepend(h('span','input-group-text',null,[h('i','bi bi-lock')]));
  const err=h('div','text-danger small mb-2',msg||'');
  const btn=h('button','btn btn-acc btn-lg w-100',null,[ic('box-arrow-in-right'),'Entrar']);
  const forgot=h('button','btn btn-link w-100 mt-2 text-decoration-none','¿Olvidaste tu contraseña?'); forgot.type='button';
  let tries=0;
  btn.onclick=()=>seguro(async()=>{
    const u=user.value.trim().toLowerCase();
    if(!/^[a-z0-9._]{3,20}$/.test(u)||pw.value.length<8){err.textContent='Escribe tu usuario y tu contraseña.';return;}
    if(++tries>5){err.textContent='Demasiados intentos. Espera un minuto.';setTimeout(()=>tries=0,60000);return;}
    btn.disabled=true;
    const {error}=await sb.auth.signInWithPassword({email:u+'@'+APP_CONFIG.EMAIL_DOMAIN,password:pw.value});
    btn.disabled=false;
    if(error){err.textContent='Usuario o contraseña incorrectos.';return;}
    sb.rpc('log_event',{p_action:'login',p_detail:null}).then(()=>{},()=>{});
    boot();
  });
  forgot.onclick=()=>seguro(async()=>{
    const r=await formModal('¿Olvidaste tu contraseña?',[{key:'u',label:'Tu nombre de usuario',max:20}],'Avisar al administrador');
    if(!r) return; const u=r.u.trim().toLowerCase();
    if(!/^[a-z0-9._]{3,20}$/.test(u)) return toast('Escribe un usuario válido.',false);
    await rpc('request_reset',{p_username:u});
    toast('Listo. Si el usuario existe, el administrador ya recibió tu solicitud.');
  });
  pw.onkeydown=e=>{if(e.key==='Enter')btn.click()};
  app.append(h('div','card login-card',null,[h('div','logo',null,[h('i','bi bi-fire')]),h('h3','text-center mb-0','Tamales'),h('p','text-center text-secondary mb-4','Gestión del negocio'),ug,P.el,err,btn,forgot]));
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
  const sf=await sb.rpc('staff_list'); if(!sf.error&&sf.data) st.staff=new Map(sf.data.map(x=>[x.id,x]));
  if(isAdmin()){ const [u,rs]=await Promise.all([sb.from('profiles').select('id,full_name,username,role,active,cargo,phone').order('full_name'),sb.from('reset_requests').select('id,user_id,created_at').eq('handled',false)]); if(u.error||rs.error) throw (u.error||rs.error); st.users=u.data; st.resets=rs.data; }
}
let ch;
function subscribe(){
  if(ch) sb.removeChannel(ch);
  ch=sb.channel('live').on('postgres_changes',{event:'*',schema:'public'},()=>seguro(async()=>{await loadAll(); if(st.view!=='cocina'&&!document.querySelector('.ov')) render();})).subscribe();
}
const byKind = k => st.cats.filter(c=>c.kind===k);
const salsaName = id => (st.cats.find(c=>c.id===id)||{}).name||'?';

/* ---------- Vistas ---------- */
function render(){
  app.replaceChildren(); document.body.classList.remove('login-bg');
  const ALL={cocina:['fire','Cocina'],tamales:['basket3','Tamales'],caja:['cash-coin','Caja'],envios:['truck','Envíos'],apartados:['bookmark-star','Apartados'],clientes:['person-lines-fill','Clientes'],ventas:['receipt','Ventas'],catalogo:['journal-richtext','Catálogo'],cats:['tags','Categorías'],users:['people','Usuarios'],storage:['hdd','Almacenamiento'],matriz:['shield-check','Matriz'],calendario:['calendar3','Calendario']};
  const allow=isAdmin()?Object.keys(ALL):(({cajero:['caja','envios','apartados','clientes','catalogo'],cocinero:['cocina','tamales','calendario'],repartidor:['envios'],general:['cocina','tamales','caja','envios','apartados','clientes','ventas','calendario','catalogo']})[st.me.cargo]||['catalogo']);
  if(!allow.includes(st.view)) st.view=allow[0];
  const go=v=>{st.view=v;render();window.scrollTo(0,0);};
  const logout=async()=>{ if(await confirmar('¿Cerrar sesión?')){ try{ await sb.rpc('log_event',{p_action:'logout',p_detail:null}); }catch(e){}
    await sb.auth.signOut(); st.me=null; loginView(); } };
  const badgeFor=v=>v==='users'&&st.resets.length?[h('span','badge bg-danger ms-1',String(st.resets.length))]:[];
  const mkTheme=()=>{ const t=h('select','form-select form-select-sm theme-sel');
    [['claro','Claro'],['oscuro','Oscuro'],['muertos','Día de Muertos'],['patrio','Fiestas Patrias'],['navidad','Navidad']].forEach(([v,l])=>{const o=h('option',null,l);o.value=v;t.append(o)});
    t.value=document.documentElement.dataset.theme; t.onchange=()=>setTheme(t.value); return t; };
  const mainKeys=['cocina','tamales','caja','envios','apartados','clientes','ventas','calendario','catalogo'].filter(k=>allow.includes(k)), admKeys=['cats','users','storage','matriz'].filter(k=>allow.includes(k));
  const link=(k,cls)=>{const b=h('button',cls+(st.view===k?' on':''),null,[ic(ALL[k][0]),h('span',null,ALL[k][1]),...badgeFor(k)]); b.title=ALL[k][1]; b.onclick=()=>go(k); return b;};
  const links=mainKeys.map(k=>link(k,'navlink'));
  if(admKeys.length){
    const dd=h('div','dd'), menu=h('div','dd-menu'); admKeys.forEach(k=>menu.append(link(k,'navlink')));
    const tg=h('button','navlink'+(admKeys.includes(st.view)?' on':''),null,[ic('gear'),h('span',null,'Administración'),...(st.resets.length?[h('span','badge bg-danger ms-1',String(st.resets.length))]:[]),h('i','bi bi-chevron-down')]);
    tg.onclick=e=>{e.stopPropagation();menu.classList.toggle('open');}; dd.append(tg,menu); links.push(dd);
    if(!window._ddBound){ window._ddBound=1; document.addEventListener('click',()=>document.querySelectorAll('.dd-menu.open').forEach(m=>m.classList.remove('open'))); }
  }
  const out=h('button','btn btn-sm btn-outline-secondary',null,[ic('box-arrow-right'),'Salir']); out.onclick=logout;
  const top=h('header','topbar no-print',null,[h('div','topbar-in',null,[h('div','brand',null,[h('i','bi bi-fire'),h('span',null,APP_CONFIG.BUSINESS_NAME||'Tamales')]),
    h('span','sect',ALL[st.view][1]),h('nav','topnav',null,links),h('div','topright',null,[mkTheme(),h('span','who d-none d-xl-inline',st.me.full_name),out])])]);
  // Navegación inferior (móvil): 4 principales + "Más"
  const prio=['caja','envios','apartados','tamales','cocina','calendario','ventas','clientes','catalogo','cats','users','storage','matriz'].filter(k=>allow.includes(k));
  const prim=prio.length<=5?prio.slice(0,5):prio.slice(0,4), rest=prio.filter(k=>!prim.includes(k));
  const masSheet=()=>{
    const ov=h('div','ov sheet'), bx=h('div','box text-start'), close=()=>ov.remove(); ov.onclick=e=>{if(e.target===ov)close();};
    if(rest.length) bx.append(h('div','sheet-grid',null,rest.map(k=>{const b=h('button','sheet-item',null,[h('i','bi bi-'+ALL[k][0]),h('span',null,ALL[k][1]),...badgeFor(k)]); b.onclick=()=>{close();go(k);}; return b;})));
    const o2=h('button','btn btn-outline-secondary w-100 mt-3',null,[ic('box-arrow-right'),'Cerrar sesión · '+st.me.full_name]); o2.onclick=()=>{close();logout();};
    bx.append(h('label','small text-secondary mt-3','Tema'),mkTheme(),o2); ov.append(bx); document.body.append(ov);
  };
  const items=prim.map(k=>{const b=h('button','bn'+(st.view===k?' on':''),null,[h('i','bi bi-'+ALL[k][0]),h('span',null,ALL[k][1]),...badgeFor(k)]); b.onclick=()=>go(k); return b;});
  const mas=h('button','bn'+(rest.includes(st.view)?' on':''),null,[h('i','bi bi-grid'),h('span',null,'Más'),...(rest.includes('users')&&st.resets.length?[h('span','badge bg-danger',String(st.resets.length))]:[])]); mas.onclick=masSheet; items.push(mas);
  const V={cocina,tamales,caja,envios,apartados,clientes,ventas,catalogo,cats,users:usuarios,storage:almacenamiento,matriz,calendario};
  app.append(top,h('main','container py-3',null,[(V[st.view]||cocina)()]),h('nav','bottom-nav no-print',null,items));
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
  [['salsa','Salsas'],['cantidad','Botones de cantidad'],['sucursal','Sucursales']].forEach(([kind,title])=>{
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
  if(error){
    let m='No se pudo completar.';
    if(error.name==='FunctionsFetchError') m='No hay conexión con la función admin-users (¿está desplegada? ¿ALLOWED_ORIGIN es correcto?).';
    else if(error.context){
      const s=error.context.status;
      try{ const j=await error.context.json(); m=j.error||j.message||j.msg||('Error '+s); }catch{ m='Error '+(s||'desconocido')+' de la función.'; }
      if(s===404) m='La función admin-users no existe en Supabase (no está desplegada o tiene otro nombre).';
      if(s===401) m='La función rechazó tu sesión (401). Cierra sesión y vuelve a entrar.';
    }
    const e=new Error(m); e.msg=m; throw e;
  }
  return data;
}
function mostrarClave(pw){
  const ov=h('div','ov'); const i=h('input','form-control text-center fs-5 mb-3'); i.value=pw; i.readOnly=true;
  const ok=h('button','btn btn-acc',null,[ic('check-lg'),'Ya la copié']); ok.onclick=()=>ov.remove();
  ov.append(h('div','box',null,[h('p','fw-bold','Contraseña temporal: se muestra una sola vez'),i,h('p','small','La persona deberá cambiarla al entrar.'),ok]));
  document.body.append(ov); i.select();
}
function usuarios(){
  const wrap=h('div');
  const reset=u=>seguro(async()=>{
    if(!await confirmar(`¿Restablecer la contraseña de ${u.full_name}?`))return;
    const r=await llamar({action:'reset_password',user_id:u.id});
    await rpc('resolve_reset',{p_user:u.id}); await loadAll(); render(); mostrarClave(r.password);
  });
  const dismiss=u=>seguro(async()=>{ if(!await confirmar(`¿Descartar la solicitud de ${u.full_name}?`))return; await rpc('resolve_reset',{p_user:u.id}); await loadAll(); render(); toast('Solicitud descartada'); });
  if(st.resets.length){
    const rb=h('div','card p-3 mb-3 border-warning'); rb.append(h('h6',null,null,[ic('bell-fill'),'Solicitudes de contraseña']));
    st.resets.forEach(q=>{ const u=st.users.find(x=>x.id===q.user_id); if(!u) return;
      const a=h('button','btn btn-sm btn-acc',null,[ic('key'),'Restablecer']); a.onclick=()=>reset(u);
      const d=h('button','btn btn-sm btn-outline-secondary',null,[ic('x-lg'),'Descartar']); d.onclick=()=>dismiss(u);
      rb.append(h('div','d-flex flex-wrap align-items-center gap-2 mb-2',null,[h('span','flex-grow-1',`${u.full_name} (@${u.username}) · ${fdt(q.created_at)}`),a,d])); });
    wrap.append(rb);
  }
  const box=h('div','card p-3 mb-3'); box.append(h('h6',null,'Nuevo usuario'));
  const nm=h('input','form-control mb-2'); nm.placeholder='Nombre completo'; nm.maxLength=80;
  const un=h('input','form-control'); un.placeholder='usuario'; un.maxLength=20; un.autocapitalize='none'; un.spellcheck=false; const ug=h('div','input-group mb-2',null,[un,h('span','input-group-text','@'+APP_CONFIG.EMAIL_DOMAIN)]);
  const ph=h('input','form-control mb-2'); ph.placeholder='Celular (10 dígitos)'; ph.type='tel'; ph.inputMode='numeric'; ph.maxLength=10;
  const rl=h('select','form-select mb-2'); [['usuario','Empleado'],['administrador','Administrador']].forEach(([v,l])=>{const o=h('option',null,l);o.value=v;rl.append(o)});
  const cg=h('select','form-select mb-2'); CARGOS.forEach(([v,l])=>{const o=h('option',null,l);o.value=v;cg.append(o)});
  rl.onchange=()=>{cg.disabled=rl.value==='administrador';};
  const add=h('button','btn btn-acc',null,[ic('person-plus'),'Crear usuario']);
  const aviso=h('div','small text-danger mt-2');
  add.onclick=()=>seguro(async()=>{
    aviso.textContent='';
    const fail=m=>{ aviso.textContent=m; toast(m,false); };
    const u=un.value.trim().toLowerCase(), tel=ph.value.replace(/\D/g,'');
    if(nm.value.trim().length<2||!/^[a-z0-9._]{3,20}$/.test(u)) return fail('Escribe un nombre y un usuario válido (3 a 20: letras, números, punto o guion bajo).');
    if(!/^[0-9]{10}$/.test(tel)) return fail('El celular debe tener 10 dígitos.');
    let ver=null, why='';
    try{ ver=await llamar({action:'version'}); }catch(e){ why=e.msg||'sin respuesta'; }
    if(!ver||ver.version<6) return fail(ver?`La función admin-users instalada es la versión ${ver.version} y se necesita la 6. Vuelve a desplegar index.ts.`:`La función admin-users instalada es una versión anterior (respondió: ${why}). Vuelve a desplegar index.ts.`);
    if(!await confirmar(`¿Crear a ${nm.value.trim()} (@${u}) como ${rl.value==='administrador'?'administrador':'empleado ('+cg.value+')'}?`)) return;
    try{
      const r=await llamar({action:'create',full_name:nm.value.trim(),username:u,role:rl.value,cargo:cg.value,phone:tel});
      await loadAll(); render(); mostrarClave(r.password);
    }catch(e){ aviso.textContent=e.msg||'No se pudo crear el usuario.'; throw e; }
  });
  box.append(nm,ug,ph,rl,cg,add,aviso); wrap.append(box);
  st.users.forEach(u=>{
    const locked=u.id===st.me.id||(u.role==='master'&&st.me.role!=='master');
    const cl=(CARGOS.find(c=>c[0]===u.cargo)||[])[1]||'';
    const row=h('div','card p-2 mb-2 d-flex flex-row align-items-center gap-2 flex-wrap',null,[h('span','flex-grow-1',`${u.full_name} (@${u.username||'—'}) · ${u.role==='usuario'?cl:u.role} · ${u.phone||'sin celular'}${u.active?'':' · deshabilitado'}`)]);
    if(!locked){
      const ed=h('button','btn btn-sm btn-outline-secondary',null,[ic('pencil')]); ed.title='Cargo y celular';
      ed.onclick=()=>seguro(async()=>{
        const f=await formModal('Datos del empleado',[{key:'c',label:'Cargo',options:CARGOS,value:u.cargo},{key:'p',label:'Celular (10 dígitos)',type:'tel',mode:'numeric',max:10,value:u.phone}],'Guardar'); if(!f) return;
        const tel=f.p.replace(/\D/g,''); if(!/^[0-9]{10}$/.test(tel)) return toast('El celular debe tener 10 dígitos.',false);
        if(!await confirmar(`¿Guardar los cambios de ${u.full_name}?`)) return;
        await llamar({action:'update_profile',user_id:u.id,cargo:f.c,phone:tel}); await loadAll(); render(); toast('Actualizado');
      });
      const rs=h('button','btn btn-sm btn-outline-secondary',null,[ic('key')]); rs.title='Restablecer contraseña'; rs.onclick=()=>reset(u);
      const tg=h('button','btn btn-sm btn-outline-'+(u.active?'danger':'success'),null,[ic(u.active?'person-x':'person-check')]); tg.title=u.active?'Deshabilitar':'Habilitar';
      tg.onclick=()=>seguro(async()=>{ if(!await confirmar(u.active?`¿Deshabilitar a ${u.full_name}?`:`¿Habilitar a ${u.full_name}?`))return; await llamar({action:'set_active',user_id:u.id,active:!u.active}); await loadAll(); render(); toast('Listo'); });
      row.append(ed,rs,tg);
    }
    wrap.append(row);
  });
  return wrap;
}
function cambiarClaveView(){
  app.replaceChildren();
  const A=pwField('Nueva contraseña (mínimo 10)','new-password'), B=pwField('Repítela','new-password'); const a=A.input, b=B.input;
  const go=h('button','btn btn-acc w-100','Guardar contraseña');
  go.onclick=()=>seguro(async()=>{
    if(a.value.length<10||!/[a-z]/.test(a.value)||!/[A-Z]/.test(a.value)||!/\d/.test(a.value)) return toast('Mínimo 10 caracteres, con mayúscula, minúscula y número.',false);
    if(a.value!==b.value) return toast('Las contraseñas no coinciden.',false);
    const {error}=await sb.auth.updateUser({password:a.value}); if(error) throw error;
    const r=await sb.rpc('clear_must_change'); if(r.error) throw r.error;
    sb.rpc('log_event',{p_action:'cambio_clave',p_detail:null}).then(()=>{},()=>{});
    toast('Contraseña actualizada'); boot();
  });
  app.append(h('div','card p-4 mx-auto mt-5',null,[h('h5',null,'Crea tu contraseña nueva'),h('p','small','Es obligatoria antes de continuar.'),A.el,B.el,go]));
}

sb.auth.onAuthStateChange(e=>{ if(e==='SIGNED_OUT'){ st.me=null; loginView(); } });
boot();
