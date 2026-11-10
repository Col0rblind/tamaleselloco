'use strict';
/* Módulos de negocio. Se carga antes de app.js; usa sus helpers (h, ic, st, sb, toast, confirmar, seguro, render, isAdmin, byKind, salsaName). */

const $$ = n => Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
const fdt = d => new Date(d).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const sum = a => (a || []).reduce((x, y) => x + Number(y.amount), 0);
const r2 = n => Math.round(n * 100) / 100;
const KIND = { mostrador: 'Mostrador', envio: 'Envío', apartado: 'Apartado' };
const DL = { por_enviar: 'Por enviar', en_camino: 'En camino', entregado: 'Entregado' };
const METODOS = [['efectivo', 'Efectivo'], ['transferencia', 'Transferencia'], ['tarjeta', 'Tarjeta']];
const CARGOS = [['cajero', 'Cajero'], ['repartidor', 'Repartidor'], ['cocinero', 'Cocinero'], ['general', 'Otro / general']];
const safe = s => /^[=+\-@]/.test(String(s)) ? "'" + s : String(s);
const badge = (t, c) => h('span', 'badge bg-' + c + ' me-1', t);
const canCash = () => isAdmin() || ['cajero', 'general'].includes(st.me.cargo);
const canKitchen = () => isAdmin() || ['cocinero', 'general'].includes(st.me.cargo);
const newCart = () => ({ items: {}, kind: 'mostrador', customer: '', note: '', paid: '', method: 'efectivo', estado: '', editing: null, back: 'caja' });
const bad = m => { const e = new Error(m); e.msg = m; return e; };
const ORD = 'id,total,status,kind,delivery,note,created_at,customer_id,stock_debited,customers(name,phone,colony,street,street_number,address),payments(id,amount,method,tendered,created_at),order_items(qty,unit_price,product_id)';

/* ---------- Utilidades ---------- */
function errDb(e) { if (!e) return; const x = new Error(e.message); if (e.code === 'P0001') x.msg = e.message; else console.error(e); throw x; }
async function rpc(name, args) { const { data, error } = await sb.rpc(name, args); errDb(error); return data; }
function lazy(fn) {
  const box = h('div'); box.append(h('p', 'text-secondary', null, [ic('hourglass-split'), 'Cargando…']));
  fn(box).catch(e => { console.error(e); box.replaceChildren(h('p', 'text-danger', e && e.msg ? e.msg : 'No se pudo cargar. Revisa tu conexión.')); });
  return box;
}
function pwField(ph, ac) {
  const i = h('input', 'form-control'); i.type = 'password'; i.placeholder = ph; i.autocomplete = ac; i.maxLength = 72;
  const ey = h('i', 'bi bi-eye'), b = h('button', 'btn btn-outline-secondary', null, [ey]); b.type = 'button'; b.title = 'Mostrar u ocultar contraseña';
  b.onclick = () => { const s = i.type === 'password'; i.type = s ? 'text' : 'password'; ey.className = 'bi bi-eye' + (s ? '-slash' : ''); };
  return { input: i, el: h('div', 'input-group mb-3', null, [i, b]) };
}
function formModal(title, fields, ok = 'Continuar') {
  return new Promise(res => {
    const ov = h('div', 'ov'), done = v => { ov.remove(); res(v); }, inputs = {}, body = h('div', 'text-start');
    fields.forEach(f => {
      let i;
      if (f.options) { i = h('select', 'form-select mb-2'); f.options.forEach(([v, l]) => { const o = h('option', null, l); o.value = v; i.append(o); }); }
      else {
        i = h('input', 'form-control mb-2'); i.type = f.type || 'text'; i.placeholder = f.label;
        if (f.max) i.maxLength = f.max; if (f.min != null) i.min = f.min; if (f.step) i.step = f.step; if (f.mode) i.inputMode = f.mode;
      }
      if (f.value != null) i.value = f.value;
      inputs[f.key] = i; body.append(h('label', 'small text-secondary', f.label), i);
    });
    const yes = h('button', 'btn btn-acc px-4', ok); yes.onclick = () => { const o = {}; for (const k in inputs) o[k] = inputs[k].value; done(o); };
    const no = h('button', 'btn btn-outline-secondary px-4', 'Cancelar'); no.onclick = () => done(null);
    ov.append(h('div', 'box', null, [h('h5', 'mb-3', title), body, h('div', 'd-flex gap-2 justify-content-center mt-2', null, [no, yes])]));
    document.body.append(ov);
  });
}
function msgModal(title, big, sub) {
  const ov = h('div', 'ov'), b = h('button', 'btn btn-acc px-4', 'Entendido'); b.onclick = () => ov.remove();
  ov.append(h('div', 'box', null, [h('h5', null, title), h('div', 'big my-2', big), sub ? h('p', 'text-secondary', sub) : '', b])); document.body.append(ov);
}

/* ---------- Catálogo en memoria, etiquetas y direcciones ---------- */
async function getCat() {
  const [p, c] = await Promise.all([sb.from('products').select('*').order('name'), sb.from('combo_items').select('combo_id,product_id,qty')]);
  if (p.error || c.error) throw (p.error || c.error);
  const prods = new Map(p.data.map(x => [x.id, x])), combos = new Map();
  c.data.forEach(i => { if (!combos.has(i.combo_id)) combos.set(i.combo_id, []); combos.get(i.combo_id).push(i); });
  return { list: p.data, prods, combos };
}
const imgUrl = p => p && p.image ? sb.storage.from('catalogo').getPublicUrl(p.image).data.publicUrl : null;
const comboTxt = (cat, p) => (cat.combos.get(p.id) || []).map(i => `${i.qty} ${(cat.prods.get(i.product_id) || {}).name || '?'}`).join(' + ');
const lineas = (o, cat) => (o.order_items || []).map(i => {
  const p = cat.prods.get(i.product_id) || { name: 'Producto eliminado' };
  return { txt: `${i.qty} × ${p.name}`, sub: p.is_combo ? comboTxt(cat, p) : '', total: Number(i.unit_price) * i.qty };
});
const dirCliente = c => [c.street && (c.street + (c.street_number ? ' #' + c.street_number : '')), c.colony].filter(Boolean).join(', ') || c.address || 'Sin dirección';
// Cómo se pagó y en qué va el pedido
function etiqueta(o) {
  const saldo = Number(o.total) - sum(o.payments), pg = sum(o.payments);
  if (o.status === 'cancelado') return ['CANCELADO', 'secondary'];
  if (o.status === 'entregado') return saldo > 0.001 ? ['ENTREGADO X COBRAR', 'danger'] : ['PAGADO ENTREGADO', 'success'];
  if (saldo <= 0.001) return [o.kind === 'apartado' ? 'APARTADO PAGADO X ENTREGAR' : 'PAGADO X ENTREGAR', 'primary'];
  if (o.kind === 'apartado') return ['APARTADO X ABONAR X ENTREGAR', 'warning'];
  return pg > 0 ? ['ABONADO X COBRAR X ENTREGAR', 'warning'] : ['X COBRAR X ENTREGAR', 'danger'];
}

/* ---------- Cobros, WhatsApp, detalle y ticket ---------- */
async function abonar(o, saldo, sinRender, cat) {
  const r = await formModal(`Cobrar · pedido #${o.id}`, [
    { key: 'a', label: `Recibido (saldo ${$$(saldo)})`, type: 'number', min: 0.01, step: '0.01', mode: 'decimal' },
    { key: 'm', label: 'Método de pago', options: METODOS }], 'Cobrar');
  if (!r) return null;
  const v = r2(Number(r.a));
  if (r.a === '' || !Number.isFinite(v) || v <= 0 || v > 10000000) { toast('Escribe un monto válido.', false); return null; }
  if (r.m !== 'efectivo' && v > saldo + 0.001) { toast('Solo en efectivo se da cambio. Máximo ' + $$(saldo), false); return null; }
  const ap = Math.min(v, saldo), ch = r2(v - ap);
  if (!await confirmar(`¿Cobrar ${$$(ap)}${ch > 0 ? ' y dar cambio de ' + $$(ch) : ''}?`)) return null;
  await rpc('add_payment', { p_order: o.id, p_tendered: v, p_method: r.m });
  if (ch > 0) msgModal('Cambio a entregar', $$(ch), `Recibido ${$$(v)} · Cobrado ${$$(ap)}`); else toast('Pago registrado');
  if (!sinRender) { render(); avisar(await cargarPedido(o.id), 'pago', cat); }
  return ap;
}
async function cargarPedido(id) { const r = await sb.from('orders').select(ORD).eq('id', id).single(); errDb(r.error); return r.data; }

function verTicket(o, cat, tipo) {
  const ov = h('div', 'ov ticket-ov'), bx = h('div', 'box text-start'), t = h('div', 'ticket'), [lab] = etiqueta(o), pg = sum(o.payments), cu = o.customers;
  t.id = 'print-ticket';
  t.append(h('h5', 'text-center mb-0', APP_CONFIG.BUSINESS_NAME || 'Tamales'), h('div', 'text-center small mb-2', 'Comprobante de compra'),
    h('div', 'small', `Pedido #${o.id} · ${fdt(o.created_at)}`), h('div', 'small', `Tipo: ${KIND[o.kind]}${cu ? ' · Cliente: ' + cu.name : ''}`));
  if (o.kind === 'envio' && cu) t.append(h('div', 'small', 'Entrega en: ' + dirCliente(cu)), h('div', 'small', 'Estado del envío: ' + (DL[o.delivery] || '')));
  t.append(h('hr'));
  lineas(o, cat).forEach(l => {
    t.append(h('div', 'd-flex justify-content-between small', null, [h('span', null, l.txt), h('span', null, $$(l.total))]));
    if (l.sub) t.append(h('div', 'small text-secondary ps-2', l.sub));
  });
  t.append(h('hr'), h('div', 'd-flex justify-content-between fw-bold', null, [h('span', null, 'TOTAL'), h('span', null, $$(o.total))]));
  o.payments.forEach(p => {
    t.append(h('div', 'small d-flex justify-content-between', null, [h('span', null, `Pago ${p.method} · ${fdt(p.created_at)}`), h('span', null, $$(p.amount))]));
    if (p.tendered && Number(p.tendered) > Number(p.amount)) t.append(h('div', 'small text-secondary ps-2', `Recibido ${$$(p.tendered)} · Cambio ${$$(Number(p.tendered) - Number(p.amount))}`));
  });
  t.append(h('div', 'small d-flex justify-content-between', null, [h('span', null, 'Pagado'), h('span', null, $$(pg))]),
    h('div', 'small d-flex justify-content-between', null, [h('span', null, 'Saldo'), h('span', null, $$(Math.max(0, Number(o.total) - pg)))]),
    h('div', 'text-center fw-bold mt-2', lab), h('div', 'text-center small mt-2', '¡Gracias por su compra!'));
  const dl = h('button', 'btn btn-acc w-100 mb-2', null, [ic('file-earmark-pdf'), 'Descargar PDF']); dl.onclick = () => descargar(pdfTicket(ticketLines(o, cat)), `ticket-${o.id}.pdf`);
  const wa = h('button', 'btn btn-success w-100 mb-2', null, [ic('whatsapp'), 'Compartir por WhatsApp']); wa.onclick = () => avisar(o, tipo || (o.kind === 'apartado' ? 'apartado' : 'nuevo'), cat);
  const x = h('button', 'btn btn-outline-secondary w-100', 'Cerrar'); x.onclick = () => ov.remove();
  bx.append(t, h('div', 'mt-3', null, [dl, wa, x])); ov.append(bx); document.body.append(ov);
}
function verDetalle(o, cat) {
  const ov = h('div', 'ov'), bx = h('div', 'box text-start'), [lab, col] = etiqueta(o), pg = sum(o.payments), cu = o.customers;
  bx.append(h('h5', null, `Pedido #${o.id}`), h('div', 'mb-2', null, [badge(lab, col), badge(KIND[o.kind], 'dark'), ...(o.delivery ? [badge(DL[o.delivery], 'primary')] : []), ...(o.status === 'listo' ? [badge('Listo', 'info')] : [])]),
    h('div', 'small text-secondary mb-2', fdt(o.created_at) + (cu ? ' · ' + cu.name : '')));
  if (cu && o.kind !== 'mostrador') bx.append(h('div', 'small', null, [ic('geo-alt'), dirCliente(cu) + ' · ', ic('telephone'), cu.phone || 'sin celular']));
  bx.append(h('hr', 'my-2'));
  lineas(o, cat).forEach(l => { bx.append(h('div', 'd-flex justify-content-between', null, [h('span', null, l.txt), h('span', null, $$(l.total))])); if (l.sub) bx.append(h('div', 'small text-secondary ps-2', 'Incluye: ' + l.sub)); });
  bx.append(h('hr', 'my-2'), h('div', 'd-flex justify-content-between fw-bold', null, [h('span', null, 'Total'), h('span', null, $$(o.total))]),
    h('div', 'small', `Pagado ${$$(pg)} · Saldo ${$$(Math.max(0, Number(o.total) - pg))}`));
  o.payments.forEach(p => bx.append(h('div', 'small text-secondary', `${fdt(p.created_at)} · ${p.method} · ${$$(p.amount)}`)));
  if (o.note) bx.append(h('div', 'small fst-italic mt-1', 'Nota: ' + o.note));
  const tk = h('button', 'btn btn-outline-secondary w-100 mt-3', null, [ic('receipt'), 'Ver ticket']); tk.onclick = () => { ov.remove(); verTicket(o, cat); };
  const x = h('button', 'btn btn-acc w-100 mt-2', 'Cerrar'); x.onclick = () => ov.remove();
  bx.append(tk, x); ov.append(bx); document.body.append(ov);
}

/* ---------- Tarjeta de pedido con acciones según cargo ---------- */
function editar(o) {
  const items = {}; (o.order_items || []).forEach(i => { items[i.product_id] = (items[i.product_id] || 0) + i.qty; });
  st.cart = { ...newCart(), items, kind: o.kind, customer: o.customer_id ? String(o.customer_id) : '', note: o.note || '', editing: o.id, back: st.view };
  st.view = 'caja'; render();
}
function acciones(row, o, cat, saldo) {
  const adm = isAdmin(), cg = st.me.cargo, cash = canCash(), repar = cg === 'repartidor';
  const mk = (txt, icon, fn, cls = 'btn-outline-secondary') => { const b = h('button', 'btn btn-sm ' + cls, null, [ic(icon), txt]); b.onclick = () => seguro(fn); row.append(b); };
  const set = async (status, delivery, msg, aviso) => {
    if (!await confirmar(msg)) return;
    await rpc('set_order_status', { p_order: o.id, p_status: status, p_delivery: delivery }); toast('Actualizado'); render(); if (aviso) avisar(await cargarPedido(o.id), aviso, cat);
  };
  mk('Detalle', 'list-ul', () => verDetalle(o, cat));
  if (saldo > 0.001 && (cash || (repar && o.kind === 'envio'))) mk(o.kind === 'apartado' ? 'Abonar' : 'Cobrar', 'cash-coin', () => abonar(o, saldo, false, cat), 'btn-acc');
  if (o.status === 'pendiente' && (adm || cash || (cg === 'cocinero' && o.kind === 'envio')))
    mk('Marcar listo', 'check2', () => set('listo', null, `¿El pedido #${o.id} está listo? Se descontarán los tamales del inventario.`, o.customer_id ? 'listo' : null));
  if (o.kind === 'envio' && o.delivery === 'por_enviar' && (adm || cash || (repar && o.status === 'listo')))
    mk('Salió a reparto', 'truck', () => set(o.status === 'pendiente' ? 'listo' : o.status, 'en_camino', `¿El pedido #${o.id} salió a reparto?`, 'camino'));
  if (o.kind === 'apartado' && saldo <= 0.001 && o.customer_id && (adm || cash))
    mk('Salió a reparto', 'truck', () => set(o.status === 'pendiente' ? 'listo' : o.status, 'en_camino', `¿El apartado #${o.id} salió a reparto?`, 'camino'));
  if (o.kind === 'envio' && o.delivery === 'en_camino' && (adm || cash || repar))
    mk(saldo > 0.001 ? 'Cobrar y entregar' : 'Entregado', 'box-seam', async () => {
      if (saldo > 0.001) { const ap = await abonar(o, saldo, true); if (ap === null) return; if (ap < saldo - 0.001) { toast('Aún queda saldo por cobrar.', false); render(); return; } }
      await set('entregado', null, `¿Confirmas que el pedido #${o.id} fue entregado?`, 'entregado');
    }, 'btn-acc');
  if (o.kind !== 'envio' && saldo <= 0.001 && ['pendiente', 'listo'].includes(o.status) && (adm || cash))
    mk('Entregar', 'box-seam', () => set('entregado', null, `¿Entregar el pedido #${o.id} al cliente?`, o.customer_id ? 'entregado' : null), 'btn-acc');
  if (o.status === 'listo' && (adm || cash)) mk('Regresar a pendiente', 'arrow-counterclockwise', () => set('pendiente', null, '¿Regresar a pendiente? Los tamales vuelven al inventario.', null));
  if (o.status === 'pendiente' && cash) mk('Editar', 'pencil', () => editar(o));
  mk('Ticket', 'receipt', () => verTicket(o, cat));
}
function pedidoCard(o, cat) {
  const pg = sum(o.payments), saldo = r2(Number(o.total) - pg), [t, col] = etiqueta(o), cu = o.customers, c = h('div', 'card p-3 mb-2');
  c.append(h('div', 'd-flex justify-content-between gap-2', null, [h('strong', null, `#${o.id} · ${cu ? cu.name : 'Mostrador'}`), h('strong', null, $$(o.total))]),
    h('div', 'my-1', null, [badge(t, col), badge(KIND[o.kind], 'dark'), ...(o.status === 'listo' ? [badge('Listo', 'info')] : []), ...(o.delivery && o.status !== 'entregado' ? [badge(DL[o.delivery], 'primary')] : [])]));
  lineas(o, cat).forEach(l => c.append(h('div', 'small', l.txt + (l.sub ? ` (${l.sub})` : ''))));
  if (o.kind !== 'mostrador' && cu) c.append(h('div', 'small text-secondary mt-1', null, [ic('geo-alt'), dirCliente(cu) + ' · ', ic('telephone'), cu.phone || 'sin celular']));
  if (o.note) c.append(h('div', 'small fst-italic', 'Nota: ' + o.note));
  c.append(h('div', 'small mt-1', `Pagado ${$$(pg)} · Saldo ${$$(saldo)}`));
  const row = h('div', 'd-flex flex-wrap gap-2 mt-2'); acciones(row, o, cat, saldo); c.append(row); return c;
}
function listaPedidos(titulo, vacio, filtrar, post) {
  return lazy(async box => {
    const [cat, r] = await Promise.all([getCat(), filtrar(sb.from('orders').select(ORD)).order('created_at').limit(200)]);
    if (r.error) throw r.error;
    const data = post ? r.data.filter(post) : r.data;
    box.replaceChildren(h('h5', null, titulo));
    if (!data.length) box.append(h('p', 'text-secondary', vacio));
    data.forEach(o => box.append(pedidoCard(o, cat)));
  });
}
const envios = () => listaPedidos('Envíos y apartados pagados por entregar', 'No hay envíos pendientes.',
  q => q.in('kind', ['envio', 'apartado']).neq('status', 'cancelado').neq('status', 'entregado'), o => o.kind === 'envio' || Number(o.total) - sum(o.payments) <= 0.001);
const apartados = () => listaPedidos('Apartados', 'No hay apartados pendientes.', q => q.eq('kind', 'apartado').neq('status', 'cancelado').neq('status', 'entregado'));

/* ---------- Clientes ---------- */
async function formCliente(c) {
  const f = await formModal(c ? 'Editar cliente' : 'Nuevo cliente', [
    { key: 'n', label: 'Nombre', max: 80, value: c && c.name }, { key: 't', label: 'Celular (10 dígitos)', type: 'tel', mode: 'numeric', max: 10, value: c && c.phone },
    { key: 'c', label: 'Colonia o barrio', max: 60, value: c && c.colony }, { key: 's', label: 'Calle', max: 80, value: c && c.street },
    { key: 'e', label: 'Número de calle', max: 10, value: c && c.street_number }], 'Guardar');
  if (!f) return null;
  const rec = { name: f.n.trim().replace(/\s+/g, ' '), phone: f.t.replace(/\D/g, ''), colony: f.c.trim(), street: f.s.trim(), street_number: f.e.trim() };
  if (rec.name.length < 2) { toast('Escribe el nombre.', false); return null; }
  if (!/^[0-9]{10}$/.test(rec.phone)) { toast('El celular debe tener 10 dígitos.', false); return null; }
  if (!rec.colony || !rec.street || !rec.street_number) { toast('Completa colonia, calle y número.', false); return null; }
  if (!await confirmar(`¿Guardar a ${rec.name}?`)) return null;
  const q = c ? sb.from('customers').update(rec).eq('id', c.id).select('id').single() : sb.from('customers').insert(rec).select('id').single();
  const { data, error } = await q; errDb(error); return data;
}
function clientes() {
  return lazy(async box => {
    const r = await sb.from('customers').select('*').order('name').limit(500); if (r.error) throw r.error;
    box.replaceChildren();
    if (canCash()) { const add = h('button', 'btn btn-acc mb-3', null, [ic('person-plus'), 'Nuevo cliente']); add.onclick = () => seguro(async () => { if (await formCliente(null)) { toast('Cliente guardado'); render(); } }); box.append(add); }
    if (!r.data.length) box.append(h('p', 'text-secondary', 'Todavía no hay clientes.'));
    r.data.forEach(c => {
      const row = h('div', 'card p-2 mb-2 d-flex flex-row align-items-center gap-2', null, [h('div', 'flex-grow-1', null, [h('strong', null, c.name), h('div', 'small text-secondary', (c.phone || 'Sin celular') + ' · ' + dirCliente(c))])]);
      if (canCash()) { const e = h('button', 'btn btn-sm btn-outline-secondary', null, [ic('pencil')]); e.title = 'Editar'; e.onclick = () => seguro(async () => { if (await formCliente(c)) { toast('Cliente actualizado'); render(); } }); row.append(e); }
      if (isAdmin()) { const d = h('button', 'btn btn-sm btn-outline-danger', null, [ic('trash')]); d.title = 'Eliminar';
        d.onclick = () => seguro(async () => { if (!await confirmar(`¿Eliminar a ${c.name}?`)) return; const { error } = await sb.from('customers').delete().eq('id', c.id);
          if (error) return toast('No se puede eliminar: tiene pedidos registrados.', false); toast('Cliente eliminado'); render(); }); row.append(d); }
      box.append(row);
    });
  });
}

/* ---------- Caja ---------- */
function caja() {
  return lazy(async box => {
    const [cat, cu, od, lc] = await Promise.all([getCat(), sb.from('customers').select('id,name').order('name').limit(500),
      sb.from('orders').select(ORD).neq('status', 'cancelado').neq('status', 'entregado').order('created_at', { ascending: false }).limit(100),
      sb.from('cash_closures').select('*').order('to_ts', { ascending: false }).limit(5)]);
    for (const r of [cu, od, lc]) if (r.error) throw r.error;
    const from = lc.data[0] ? lc.data[0].to_ts : '2000-01-01T00:00:00Z';
    const py = await sb.from('payments').select('amount,method,orders(status)').gt('created_at', from).limit(2000); if (py.error) throw py.error;
    const C = st.cart || (st.cart = newCart());
    const prods = cat.list.filter(p => p.active || C.items[p.id]);

    const draw = () => {
      const items = prods.filter(p => C.items[p.id]), total = r2(items.reduce((a, p) => a + Number(p.price) * C.items[p.id], 0));
      const left = h('div', 'col-lg-6'), right = h('div', 'col-lg-6');
      left.append(h('h5', null, 'Productos'));
      if (!prods.length) left.append(h('p', 'text-secondary', 'Aún no hay productos. Agrégalos en Catálogo.'));
      const grid = h('div', 'd-grid gap-2');
      prods.filter(p => p.active).forEach(p => {
        const u = imgUrl(p), img = u ? h('img', 'thumb') : h('div', 'thumb d-flex align-items-center justify-content-center bg-secondary-subtle', null, [h('i', 'bi bi-fire')]);
        if (u) { img.src = u; img.alt = ''; img.loading = 'lazy'; }
        const b = h('button', 'btn btn-outline-secondary text-start d-flex align-items-center gap-2', null, [img,
          h('div', null, null, [h('div', 'fw-bold', p.name + (p.is_combo ? ' (combo)' : '')), h('small', 'text-secondary', $$(p.price) + (p.is_combo ? ' · ' + comboTxt(cat, p) : ''))])]);
        b.onclick = () => { C.items[p.id] = Math.min(1000, (C.items[p.id] || 0) + 1); draw(); }; grid.append(b);
      });
      left.append(grid);

      const cart = h('div', 'card p-3');
      cart.append(h('h5', null, C.editing ? `Editando pedido #${C.editing}` : 'Pedido'));
      if (C.editing) { const x = h('button', 'btn btn-sm btn-outline-secondary mb-2', 'Cancelar edición'); x.onclick = () => { const b = C.back; st.cart = newCart(); st.view = b || 'caja'; render(); }; cart.append(x); }
      if (!items.length) cart.append(h('p', 'text-secondary', 'Toca un producto para agregarlo.'));
      items.forEach(p => {
        const q = C.items[p.id], mkb = (icon, fn) => { const b = h('button', 'btn btn-sm btn-outline-secondary', null, [h('i', 'bi bi-' + icon)]); b.onclick = fn; return b; };
        cart.append(h('div', 'd-flex align-items-center gap-2 mb-2', null, [h('span', 'flex-grow-1', `${p.name}${p.active ? '' : ' (oculto)'} · ${$$(Number(p.price) * q)}`),
          mkb('dash-lg', () => { if (q <= 1) delete C.items[p.id]; else C.items[p.id] = q - 1; draw(); }), h('strong', null, String(q)),
          mkb('plus-lg', () => { C.items[p.id] = Math.min(1000, q + 1); draw(); }), mkb('x-lg', () => { delete C.items[p.id]; draw(); })]));
      });
      cart.append(h('div', 'd-flex gap-2 my-2 flex-wrap', null, [['mostrador', 'shop', 'Mostrador'], ['envio', 'truck', 'Envío'], ['apartado', 'bookmark-star', 'Apartado']].map(([k, i, l]) => {
        const b = h('button', 'chip' + (C.kind === k ? ' on' : ''), null, [ic(i), l]); b.onclick = () => { C.kind = k; C.estado = ''; draw(); }; return b; })));
      const cs = h('select', 'form-select'); cs.append(Object.assign(h('option', null, C.kind === 'mostrador' ? '— Sin cliente —' : '— Elige cliente (obligatorio) —'), { value: '' }));
      cu.data.forEach(c => cs.append(Object.assign(h('option', null, c.name), { value: String(c.id) }))); cs.value = C.customer; cs.onchange = () => { C.customer = cs.value; };
      const nc = h('button', 'btn btn-outline-secondary', null, [ic('person-plus')]); nc.title = 'Nuevo cliente';
      nc.onclick = () => seguro(async () => { const n = await formCliente(null); if (n) { C.customer = String(n.id); toast('Cliente guardado'); render(); } });
      const note = h('input', 'form-control mb-2'); note.placeholder = 'Nota (opcional)'; note.maxLength = 200; note.value = C.note; note.oninput = () => { C.note = note.value; };
      cart.append(h('div', 'input-group mb-2', null, [cs, nc]), note);

      const defs = ESTADOS[C.kind], hint = h('div', 'small fw-semibold mt-1'), chg = h('div', 'fs-5 mt-1');
      const upd = () => {
        const v = C.paid === '' ? 0 : Number(C.paid) || 0, ap = Math.min(Math.max(v, 0), total), d = defs.find(x => x[0] === C.estado), er = d ? validaEstado(d[1], ap, total) : '';
        chg.textContent = v > total ? `Cambio a entregar: ${$$(r2(v - total))}` : `Falta por pagar: ${$$(r2(total - ap))}`;
        hint.textContent = !d ? 'Elige el estado de la venta.' : er || 'Quedará como: ' + C.estado;
        hint.className = 'small fw-semibold mt-1 ' + (!d ? 'text-secondary' : er ? 'text-danger' : 'text-success');
      };
      if (!C.editing) {
        const es = h('select', 'form-select mb-2'); es.append(Object.assign(h('option', null, '— Estado de la venta —'), { value: '' }));
        defs.forEach(d => es.append(Object.assign(h('option', null, d[0]), { value: d[0] }))); es.value = C.estado; es.onchange = () => { C.estado = es.value; upd(); };
        const paid = h('input', 'form-control'); paid.type = 'number'; paid.min = 0; paid.step = '0.01'; paid.inputMode = 'decimal'; paid.placeholder = 'Recibido (pago / abono)'; paid.value = C.paid; paid.oninput = () => { C.paid = paid.value; upd(); };
        const met = h('select', 'form-select w-auto'); METODOS.forEach(([v, l]) => met.append(Object.assign(h('option', null, l), { value: v }))); met.value = C.method; met.onchange = () => { C.method = met.value; };
        cart.append(es, h('div', 'input-group mb-2', null, [paid, met]), chg);
      }
      cart.append(hint); upd();
      const go = h('button', 'btn btn-acc btn-lg w-100 mt-3', null, [ic('check2-circle'), (C.editing ? 'Guardar cambios · ' : 'Guardar pedido · ') + $$(total)]);
      go.onclick = () => seguro(async () => {
        if (!items.length) return toast('Agrega al menos un producto.', false);
        if (C.kind !== 'mostrador' && !C.customer) return toast('Un ' + KIND[C.kind].toLowerCase() + ' necesita cliente.', false);
        const payload = items.map(p => ({ product_id: p.id, qty: C.items[p.id] }));
        if (C.editing) {
          if (!await confirmar(`¿Guardar los cambios del pedido #${C.editing}?`)) return;
          await rpc('update_order', { p_order: C.editing, p_customer: C.customer ? Number(C.customer) : null, p_kind: C.kind, p_note: C.note || null, p_items: payload });
          const b = C.back; st.cart = newCart(); st.view = b || 'caja'; toast('Pedido actualizado'); render(); return;
        }
        const d = ESTADOS[C.kind].find(x => x[0] === C.estado); if (!d) return toast('Elige el estado de la venta.', false);
        const v = C.paid === '' ? 0 : r2(Number(C.paid));
        if (!Number.isFinite(v) || v < 0 || v > 10000000) return toast('Monto recibido inválido.', false);
        if (C.method !== 'efectivo' && v > total + 0.001) return toast('Solo en efectivo se da cambio.', false);
        const er = validaEstado(d[1], Math.min(v, total), total); if (er) return toast(er, false);
        if (!await confirmar(`¿Guardar como ${C.estado} por ${$$(total)}${v ? ' con pago de ' + $$(Math.min(v, total)) : ''}?`)) return;
        const oid = await rpc('create_order', { p_customer: C.customer ? Number(C.customer) : null, p_kind: C.kind, p_note: C.note || null,
          p_items: payload, p_tendered: v, p_method: C.method, p_deliver: d[2] === 1 });
        const tipo = C.kind === 'apartado' ? 'apartado' : 'nuevo';
        st.cart = newCart(); render();
        verTicket(await cargarPedido(oid), cat, tipo);
        if (v > total) msgModal('Cambio a entregar', $$(r2(v - total)), `Recibido ${$$(v)} · Cuenta ${$$(total)}`);
      });
      cart.append(go); right.append(cart);

      const pend = od.data.filter(o => o.kind === 'mostrador' || Number(o.total) - sum(o.payments) > 0.001), pe = h('div', 'mt-4');
      pe.append(h('h5', null, 'Pedidos por cobrar o entregar'));
      if (!pend.length) pe.append(h('p', 'text-secondary', 'No hay pedidos pendientes.'));
      pend.slice(0, 30).forEach(o => pe.append(pedidoCard(o, cat)));

      const pays = py.data.filter(p => !p.orders || p.orders.status !== 'cancelado'), por = m => pays.filter(p => p.method === m).reduce((a, p) => a + Number(p.amount), 0);
      const ct = h('div', 'card p-3 mt-4'); ct.append(h('h5', null, null, [ic('scissors'), 'Corte de caja']),
        h('p', 'mb-2', `Desde el último corte: Efectivo ${$$(por('efectivo'))} · Transferencia ${$$(por('transferencia'))} · Tarjeta ${$$(por('tarjeta'))} · Total ${$$(por('efectivo') + por('transferencia') + por('tarjeta'))}`));
      const cb = h('button', 'btn btn-outline-secondary', null, [ic('scissors'), 'Hacer corte ahora']);
      cb.onclick = () => seguro(async () => { if (!await confirmar('¿Hacer el corte de caja con estos totales?')) return; await rpc('close_cash'); toast('Corte guardado'); render(); });
      ct.append(cb);
      lc.data.forEach(k => {
        const row = h('div', 'small d-flex align-items-center gap-2 mt-2', null, [h('span', 'flex-grow-1', `${fdt(k.to_ts)} · Efvo ${$$(k.efectivo)} · Transf ${$$(k.transferencia)} · Tarj ${$$(k.tarjeta)}`)]);
        if (isAdmin()) { const d = h('button', 'btn btn-sm btn-outline-danger', null, [ic('trash')]); d.title = 'Eliminar corte';
          d.onclick = () => seguro(async () => { if (!await confirmar('¿Eliminar este corte? No se puede deshacer.')) return; const { error } = await sb.from('cash_closures').delete().eq('id', k.id); errDb(error); toast('Corte eliminado'); render(); });
          row.append(d); }
        ct.append(row);
      });
      box.replaceChildren(h('div', 'row g-3', null, [left, right]), pe, ct);
    };
    draw();
  });
}

/* ---------- Ventas ---------- */
function ventas() {
  return lazy(async box => {
    const dias = { hoy: 0, '7': 7, '30': 30 }[st.range] ?? 0, d0 = new Date(); d0.setHours(0, 0, 0, 0); d0.setDate(d0.getDate() - dias);
    const [cat, r] = await Promise.all([getCat(), sb.from('orders').select(ORD).gte('created_at', d0.toISOString()).order('created_at', { ascending: false }).limit(1000)]);
    if (r.error) throw r.error;
    const ok = r.data.filter(o => o.status !== 'cancelado'), vendido = ok.reduce((a, o) => a + Number(o.total), 0), cobrado = ok.reduce((a, o) => a + sum(o.payments), 0);
    const chips = h('div', 'd-flex flex-wrap gap-2 mb-3 align-items-center', null, [['hoy', 'Hoy'], ['7', '7 días'], ['30', '30 días']].map(([k, l]) => {
      const b = h('button', 'chip' + (st.range === k ? ' on' : ''), l); b.onclick = () => { st.range = k; render(); }; return b; }));
    const ex = h('button', 'btn btn-outline-success ms-auto', null, [ic('file-earmark-excel'), 'Exportar a Excel']);
    ex.onclick = () => seguro(async () => {
      if (typeof XLSX === 'undefined') return toast('No se cargó la librería de Excel.', false);
      if (!await confirmar('¿Descargar estas ventas en Excel?')) return;
      const rows = [['#', 'Fecha', 'Cliente', 'Tipo', 'Estado', 'Productos', 'Total', 'Pagado', 'Saldo']].concat(r.data.map(o => {
        const pg = sum(o.payments); return [o.id, fdt(o.created_at), safe(o.customers ? o.customers.name : 'Mostrador'), KIND[o.kind], etiqueta(o)[0],
          safe(lineas(o, cat).map(l => l.txt).join('; ')), Number(o.total), pg, o.status === 'cancelado' ? 0 : Number(o.total) - pg]; }));
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Ventas');
      XLSX.writeFile(wb, `ventas_${new Date().toISOString().slice(0, 10)}.xlsx`);
    });
    chips.append(ex);
    const sm = h('div', 'card p-3 mb-3 text-center', null, [h('div', 'big', $$(vendido)), h('div', null, `vendido · cobrado ${$$(cobrado)} · por cobrar ${$$(vendido - cobrado)}`)]);
    const tbl = h('table', 'table table-sm align-middle');
    tbl.append(h('thead', null, null, [h('tr', null, null, ['#', 'Fecha', 'Cliente', 'Estado', 'Total', ''].map(x => h('th', null, x)))]));
    const tb = h('tbody');
    r.data.forEach(o => {
      const cancel = o.status === 'cancelado', [lab, col] = etiqueta(o), act = h('td', 'text-nowrap');
      const dt = h('button', 'btn btn-sm btn-outline-secondary me-1', null, [ic('list-ul')]); dt.title = 'Ver detalle'; dt.onclick = () => verDetalle(o, cat); act.append(dt);
      const tk = h('button', 'btn btn-sm btn-outline-secondary me-1', null, [ic('receipt')]); tk.title = 'Ticket'; tk.onclick = () => verTicket(o, cat); act.append(tk);
      if (isAdmin()) {
        if (!cancel) { const c = h('button', 'btn btn-sm btn-outline-warning me-1', null, [ic('x-circle')]); c.title = 'Cancelar venta';
          c.onclick = () => seguro(async () => { if (!await confirmar(`¿Cancelar la venta #${o.id}?`)) return; await rpc('cancel_order', { p_order: o.id }); toast('Venta cancelada'); render(); }); act.append(c); }
        const d = h('button', 'btn btn-sm btn-outline-danger', null, [ic('trash')]); d.title = 'Eliminar venta';
        d.onclick = () => seguro(async () => { if (!await confirmar(`¿Eliminar definitivamente la venta #${o.id} y sus abonos?`)) return; const { error } = await sb.from('orders').delete().eq('id', o.id); errDb(error); toast('Venta eliminada'); render(); }); act.append(d);
      }
      tb.append(h('tr', cancel ? 'opacity-50' : '', null, [h('td', null, String(o.id)), h('td', null, fdt(o.created_at)), h('td', null, o.customers ? o.customers.name : 'Mostrador'),
        h('td', null, null, [badge(lab, col)]), h('td', null, $$(o.total)), act]));
    });
    tbl.append(tb);
    box.replaceChildren(chips, sm, r.data.length ? h('div', 'table-responsive', null, [tbl]) : h('p', 'text-secondary', 'No hay ventas en este periodo.'));
  });
}

/* ---------- Tamales (antes "Hoy"): inventario y ollas ---------- */
function tamales() {
  return lazy(async box => {
    const res = await rpc('tamales_resumen');
    const total = st.batches.reduce((a, b) => a + b.qty, 0);
    box.replaceChildren(h('div', 'card p-3 mb-3 text-center', null, [h('div', 'big', String(total)), h('div', null, 'tamales sacados hoy')]), h('h6', null, 'Inventario y pedidos por surtir'));
    const row = h('div', 'row g-2 mb-3');
    res.forEach(s => {
      const falta = Math.max(0, s.pendiente - s.stock);
      row.append(h('div', 'col-6 col-md-4', null, [h('div', 'card p-2 text-center h-100', null, [h('strong', null, s.name), h('div', 'fs-3 fw-bold', String(s.stock)), h('small', null, 'disponibles'),
        h('small', 'text-secondary', `Por surtir: ${s.pendiente}`), falta > 0 ? h('small', 'text-danger fw-bold', `Faltan ${falta}`) : h('small', 'text-success', 'Alcanza')])]));
    });
    box.append(row, h('h6', null, 'Ollas de hoy'));
    if (!st.batches.length) box.append(h('p', 'text-secondary', 'Todavía no hay ollas registradas hoy.'));
    st.batches.slice(0, 40).forEach(b => {
      const line = h('div', 'card p-2 mb-2 d-flex flex-row align-items-center gap-2 flex-wrap', null, [h('span', 'flex-grow-1', `${new Date(b.created_at).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })} · ${b.qty} de ${salsaName(b.salsa_id)}`)]);
      if (canKitchen()) {
        const e = h('button', 'btn btn-sm btn-outline-secondary', null, [ic('pencil')]); e.title = 'Corregir';
        e.onclick = () => seguro(async () => {
          const f = await formModal('Corregir olla', [{ key: 'q', label: 'Cantidad de tamales', type: 'number', min: 1, max: 4, mode: 'numeric', value: b.qty },
            { key: 's', label: 'Sabor', options: byKind('salsa').map(s => [String(s.id), s.name]), value: String(b.salsa_id) }], 'Guardar');
          if (!f) return; const q = Number(f.q);
          if (!Number.isInteger(q) || q < 1 || q > 500) return toast('La cantidad debe ser un entero de 1 a 500.', false);
          if (!await confirmar(`¿Cambiar esta olla a ${q} de ${salsaName(Number(f.s))}?`)) return;
          const { error } = await sb.from('batches').update({ qty: q, salsa_id: Number(f.s) }).eq('id', b.id); errDb(error); toast('Olla corregida'); await loadAll(); render();
        });
        const d = h('button', 'btn btn-sm btn-outline-danger', null, [ic('trash')]); d.title = 'Eliminar';
        d.onclick = () => seguro(async () => { if (!await confirmar('¿Eliminar esta olla? Se descontará del inventario.')) return;
          const { error } = await sb.from('batches').delete().eq('id', b.id); errDb(error); toast('Olla eliminada'); await loadAll(); render(); });
        line.append(e, d);
      }
      box.append(line);
    });
  });
}

/* ---------- Catálogo: tamales, combos e imágenes ligeras ---------- */
async function comprimir(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw bad('Usa una imagen JPG, PNG o WebP.');
  if (file.size > 10 * 1024 * 1024) throw bad('La imagen pesa demasiado (máximo 10 MB).');
  const bmp = await createImageBitmap(file), k = Math.min(1, 480 / Math.max(bmp.width, bmp.height)), c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(bmp, 0, 0, c.width, c.height);
  let q = 0.8, blob;
  do { blob = await new Promise(r => c.toBlob(r, 'image/jpeg', q)); q -= 0.1; } while (blob && blob.size > 70 * 1024 && q > 0.3);
  if (!blob || blob.size > 95 * 1024) throw bad('No se pudo reducir la imagen. Prueba con otra.');
  return blob;
}
async function subirImagen(id, file, vieja) {
  const blob = await comprimir(file), path = `${id}-${Date.now()}.jpg`;
  const up = await sb.storage.from('catalogo').upload(path, blob, { contentType: 'image/jpeg', cacheControl: '31536000' }); if (up.error) throw up.error;
  const u = await sb.from('products').update({ image: path }).eq('id', id); if (u.error) throw u.error;
  if (vieja) await sb.storage.from('catalogo').remove([vieja]);
}
function productoModal(cat, p, combo) {
  return new Promise(res => {
    const ov = h('div', 'ov'), done = v => { ov.remove(); res(v); }, bx = h('div', 'box text-start');
    const inp = (ph, max, val, type) => { const i = h('input', 'form-control mb-2'); i.placeholder = ph; if (max) i.maxLength = max; if (type) i.type = type; if (val != null) i.value = val; return i; };
    const nm = inp('Nombre', 60, p && p.name), ds = inp('Descripción corta (opcional)', 160, p && p.description), pr = inp('Precio', null, p && p.price, 'number'); pr.min = 0; pr.step = '0.01'; pr.inputMode = 'decimal';
    const fl = h('input', 'form-control mb-2'); fl.type = 'file'; fl.accept = 'image/*';
    bx.append(h('h5', 'mb-3', (p ? 'Editar ' : 'Nuevo ') + (combo ? 'combo' : 'tamal')), h('label', 'small text-secondary', 'Nombre'), nm, h('label', 'small text-secondary', 'Descripción'), ds, h('label', 'small text-secondary', 'Precio'), pr);
    let sel = null; const qty = new Map();
    if (!combo) { sel = h('select', 'form-select mb-2'); byKind('salsa').forEach(s => sel.append(Object.assign(h('option', null, s.name), { value: String(s.id) }))); if (p && p.salsa_id) sel.value = String(p.salsa_id); bx.append(h('label', 'small text-secondary', 'Sabor (para el inventario)'), sel); }
    else {
      bx.append(h('label', 'small text-secondary', 'Cuántos tamales de cada sabor incluye (0 = no incluir)'));
      const cur = new Map((cat.combos.get(p && p.id) || []).map(i => [i.product_id, i.qty]));
      cat.list.filter(x => !x.is_combo && x.salsa_id && (x.active || cur.has(x.id))).forEach(x => {
        const i = h('input', 'form-control form-control-sm w-auto'); i.type = 'number'; i.min = 0; i.max = 1000; i.value = cur.get(x.id) || 0; i.style.width = '90px'; qty.set(x.id, i);
        bx.append(h('div', 'd-flex align-items-center gap-2 mb-1', null, [h('span', 'flex-grow-1', x.name), i]));
      });
    }
    bx.append(h('label', 'small text-secondary mt-2', 'Foto (se reduce automáticamente)'), fl);
    const yes = h('button', 'btn btn-acc px-4', 'Guardar'), no = h('button', 'btn btn-outline-secondary px-4', 'Cancelar');
    yes.onclick = () => done({ name: nm.value, desc: ds.value, price: pr.value, salsa: sel ? Number(sel.value) : null, file: fl.files[0] || null,
      items: [...qty].map(([id, i]) => ({ product_id: id, qty: Number(i.value) })).filter(i => i.qty > 0) });
    no.onclick = () => done(null);
    bx.append(h('div', 'd-flex gap-2 justify-content-center mt-3', null, [no, yes])); ov.append(bx); document.body.append(ov);
  });
}
async function guardarProducto(cat, p, combo) {
  const f = await productoModal(cat, p, combo); if (!f) return;
  const n = f.name.trim().replace(/\s+/g, ' '), pr = r2(Number(f.price));
  if (n.length < 2) return toast('Escribe el nombre.', false);
  if (f.price === '' || !Number.isFinite(pr) || pr < 0 || pr > 100000) return toast('Precio inválido (0 a 100,000).', false);
  if (!combo && !f.salsa) return toast('Elige el sabor del tamal.', false);
  if (combo && (!f.items.length || f.items.some(i => !Number.isInteger(i.qty) || i.qty > 1000))) return toast('El combo necesita al menos un tamal con cantidad válida.', false);
  if (!await confirmar(`¿Guardar "${n}" a ${$$(pr)}?`)) return;
  const id = await rpc('save_product', { p_id: p ? p.id : null, p_name: n, p_desc: f.desc.trim() || null, p_price: pr, p_salsa: f.salsa, p_combo: !!combo, p_items: combo ? f.items : null });
  if (f.file) { try { await subirImagen(id, f.file, p && p.image); } catch (e) { console.error(e); toast(e.msg || 'Se guardó, pero no se pudo subir la foto.', false); } }
  toast('Guardado'); render();
}
function catalogo() {
  return lazy(async box => {
    const cat = await getCat(); box.id = 'print-area';
    const bar = h('div', 'd-flex flex-wrap gap-2 mb-3 no-print'), pdf = h('button', 'btn btn-acc', null, [ic('file-earmark-pdf'), 'Exportar a PDF']);
    pdf.onclick = () => { toast('En la ventana elige "Guardar como PDF".'); setTimeout(() => { document.body.dataset.print = 'catalog'; window.addEventListener('afterprint', () => { delete document.body.dataset.print; }, { once: true }); window.print(); }, 800); };
    bar.append(pdf);
    if (isAdmin()) {
      const a = h('button', 'btn btn-outline-secondary', null, [ic('plus-lg'), 'Agregar tamal']); a.onclick = () => seguro(() => guardarProducto(cat, null, false));
      const b = h('button', 'btn btn-outline-secondary', null, [ic('box2-heart'), 'Agregar combo']); b.onclick = () => seguro(() => guardarProducto(cat, null, true)); bar.append(a, b);
    }
    const grid = h('div', 'row g-3');
    cat.list.filter(p => p.active || isAdmin()).forEach(p => {
      const u = imgUrl(p), card = h('div', 'card pcard', null, [h('div', 'pcard-head', null, [h('i', 'bi bi-' + (p.is_combo ? 'box2-heart' : 'fire')), p.name])]);
      if (u) { const im = h('img', 'pimg'); im.src = u; im.alt = p.name; im.loading = 'lazy'; card.append(im); }
      card.append(h('div', 'p-3', null, [h('p', 'mb-1', p.description || ''), ...(p.is_combo ? [h('p', 'small text-secondary mb-1', 'Incluye: ' + comboTxt(cat, p))] : []), h('div', 'price', $$(p.price))]));
      if (!p.active) card.classList.add('no-print', 'opacity-50');
      if (isAdmin()) {
        const ctr = h('div', 'px-3 pb-3 d-flex gap-2 flex-wrap no-print');
        const ed = h('button', 'btn btn-sm btn-outline-secondary', null, [ic('pencil'), 'Editar']); ed.onclick = () => seguro(() => guardarProducto(cat, p, p.is_combo));
        const tg = h('button', 'btn btn-sm btn-outline-secondary', null, [ic(p.active ? 'eye-slash' : 'eye'), p.active ? 'Ocultar' : 'Mostrar']);
        tg.onclick = () => seguro(async () => { if (!await confirmar(`¿${p.active ? 'Ocultar' : 'Mostrar'} "${p.name}"?`)) return; const { error } = await sb.from('products').update({ active: !p.active }).eq('id', p.id); errDb(error); render(); });
        const dl = h('button', 'btn btn-sm btn-outline-danger', null, [ic('trash')]);
        dl.onclick = () => seguro(async () => { if (!await confirmar(`¿Eliminar "${p.name}"?`)) return; const { error } = await sb.from('products').delete().eq('id', p.id);
          if (error) return toast('Ya tiene ventas o está en un combo; mejor ocúltalo.', false); if (p.image) await sb.storage.from('catalogo').remove([p.image]); toast('Eliminado'); render(); });
        ctr.append(ed, tg, dl); card.append(ctr);
      }
      grid.append(h('div', 'col-12 col-sm-6 col-lg-4', null, [card]));
    });
    box.replaceChildren(h('h4', 'mb-3', null, [ic('stars'), 'Nuestro catálogo de tamales']), bar, cat.list.length ? grid : h('p', 'text-secondary', 'Aún no hay productos en el catálogo.'));
  });
}

/* ---------- Almacenamiento (solo admin) ---------- */
function almacenamiento() {
  return lazy(async box => {
    const u = await rpc('db_usage'), fmt = b => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB';
    const barra = (usado, lim) => { const pct = Math.min(100, usado / lim * 100), b = h('div', 'progress mb-2', null, [h('div', 'progress-bar bg-' + (pct < 60 ? 'success' : pct < 85 ? 'warning' : 'danger'), `${pct.toFixed(1)}%`)]); b.firstChild.style.width = pct + '%'; return b; };
    box.replaceChildren(h('div', 'card p-3 mb-3', null, [h('h5', null, 'Base de datos'), barra(u.bytes, 500 * 1048576), h('p', 'mb-1', `Usado: ${fmt(u.bytes)} de 500 MB (límite del plan gratuito; confírmalo en tu panel de Supabase).`),
      h('small', 'text-secondary', 'Al borrar, el espacio puede tardar un poco en reflejarse.')]),
      h('div', 'card p-3 mb-3', null, [h('h5', null, 'Imágenes del catálogo'), barra(u.storage, 1024 * 1048576), h('p', 'mb-0', `Usado: ${fmt(u.storage)} de 1 GB (plan gratuito).`)]));
    const tabs = h('div', 'card p-3 mb-3'); tabs.append(h('h6', null, 'Qué ocupa espacio en la base de datos'));
    Object.entries(u.tables).sort((a, b) => b[1] - a[1]).forEach(([n, b]) => tabs.append(h('div', 'd-flex justify-content-between small', null, [h('span', null, n), h('span', null, fmt(b))])));
    const lim = h('div', 'card p-3'); lim.append(h('h6', null, 'Liberar espacio'), h('small', 'text-secondary mb-2 d-block', 'Antes de borrar ventas, expórtalas a Excel desde Ventas. Borrar ollas viejas no cambia el inventario actual.'));
    [['ollas', 'registros de cocina (ollas)'], ['ventas', 'ventas entregadas y pagadas, o canceladas']].forEach(([t, l]) => {
      const sel = h('select', 'form-select w-auto'); [30, 90, 180, 365].forEach(d => sel.append(Object.assign(h('option', null, 'con más de ' + d + ' días'), { value: d })));
      const b = h('button', 'btn btn-outline-danger', null, [ic('trash'), 'Eliminar']);
      b.onclick = () => seguro(async () => { if (!await confirmar(`¿Eliminar ${l} ${sel.options[sel.selectedIndex].text}? No se puede deshacer.`)) return;
        const n = await rpc('purge_data', { p_target: t, p_days: Number(sel.value) }); toast(`${n} registros eliminados`); render(); });
      lim.append(h('div', 'd-flex flex-wrap align-items-center gap-2 mb-2', null, [h('span', 'flex-grow-1', l), sel, b]));
    });
    box.append(tabs, lim);
  });
}

/* ---------- Estados de venta elegibles en Caja ---------- */
const ESTADOS = {
  mostrador: [['PAGADO ENTREGADO', 'pagado', 1], ['PAGADO X ENTREGAR', 'pagado', 0], ['ABONADO X COBRAR X ENTREGAR', 'abono', 0], ['X COBRAR X ENTREGAR', 'nada', 0]],
  envio: [['PAGADO X ENTREGAR', 'pagado', 0], ['ABONADO X COBRAR X ENTREGAR', 'abono', 0], ['X COBRAR X ENTREGAR', 'nada', 0]],
  apartado: [['APARTADO X ABONAR X ENTREGAR', 'abonable', 0], ['APARTADO PAGADO X ENTREGAR', 'pagado', 0]]
};
// El sistema no elige el estado: solo avisa si no coincide con lo cobrado
function validaEstado(tipo, ap, total) {
  if (tipo === 'pagado' && !(ap >= total)) return 'Este estado requiere el pago completo.';
  if (tipo === 'abono' && !(ap > 0 && ap < total)) return 'Este estado requiere un pago parcial (mayor a 0 y menor al total).';
  if (tipo === 'nada' && ap > 0) return 'Este estado es sin pago: deja "Recibido" vacío o elige ABONADO / PAGADO.';
  if (tipo === 'abonable' && total > 0 && ap >= total) return 'Ya cubre el total: elige APARTADO PAGADO X ENTREGAR.';
  return '';
}

/* ---------- Ticket en PDF real (sin librerías) y compartir ---------- */
const TW = 42;
const tpad = (l, r) => { l = String(l); r = String(r); return l.slice(0, Math.max(0, TW - r.length - 1)).padEnd(TW - r.length) + r; };
const tctr = s => ' '.repeat(Math.max(0, Math.floor((TW - s.length) / 2))) + s;
const twrap = (s, w = TW) => { const out = []; let cur = ''; String(s).split(/\s+/).forEach(wd => { if ((cur + ' ' + wd).trim().length > w) { if (cur) out.push(cur); cur = wd; } else cur = (cur + ' ' + wd).trim(); }); if (cur) out.push(cur); return out; };
function ticketLines(o, cat) {
  const L = [], add = (t, b) => L.push({ t, b: !!b }), cu = o.customers, pg = sum(o.payments), raya = '-'.repeat(TW);
  add(tctr((APP_CONFIG.BUSINESS_NAME || 'Tamales').toUpperCase()), 1); add(tctr('Comprobante de compra')); add(raya);
  add(`Pedido #${o.id}`); add(fdt(o.created_at)); add('Tipo: ' + KIND[o.kind]);
  if (cu) { twrap('Cliente: ' + cu.name).forEach(x => add(x)); if (o.kind !== 'mostrador') twrap('Entrega: ' + dirCliente(cu)).forEach(x => add(x)); }
  if (o.delivery) add('Envío: ' + DL[o.delivery]);
  add(raya);
  lineas(o, cat).forEach(l => { add(tpad(l.txt, $$(l.total))); if (l.sub) twrap('  ' + l.sub).forEach(x => add(x)); });
  add(raya); add(tpad('TOTAL', $$(o.total)), 1);
  o.payments.forEach(p => { add(tpad('Pago ' + p.method, $$(p.amount))); if (p.tendered && Number(p.tendered) > Number(p.amount)) add(tpad('  Recibido ' + $$(p.tendered) + ' Cambio', $$(Number(p.tendered) - Number(p.amount)))); });
  add(tpad('Pagado', $$(pg))); add(tpad('Saldo', $$(Math.max(0, Number(o.total) - pg)))); add(raya);
  add(tctr(etiqueta(o)[0]), 1); if (o.note) twrap('Nota: ' + o.note).forEach(x => add(x));
  add(tctr('Gracias por su compra'));
  return L;
}
function pdfTicket(lines) {
  const Wd = 226.8, fs = 8, lh = 11, m = 10, H = Math.max(200, lines.length * lh + 2 * m);
  const esc = s => String(s).replace(/[\\()]/g, '\\$&').replace(/[^\x20-\xFF]/g, '?');
  let c = ''; lines.forEach((l, i) => { c += `BT /${l.b ? 'F2' : 'F1'} ${fs} Tf ${m} ${(H - m - fs - i * lh).toFixed(1)} Td (${esc(l.t)}) Tj ET\n`; });
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${Wd} ${H}] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>`,
    `<< /Length ${c.length} >>\nstream\n${c}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>'];
  let out = '%PDF-1.4\n'; const off = [];
  objs.forEach((o, i) => { off.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xr = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + off.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xr}\n%%EOF`;
  const u = new Uint8Array(out.length); for (let i = 0; i < out.length; i++) u[i] = out.charCodeAt(i) & 255;
  return new Blob([u], { type: 'application/pdf' });
}
function descargar(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
async function compartirPDF(o, cat, texto) {
  cat = cat || await getCat();
  const blob = pdfTicket(ticketLines(o, cat)), file = new File([blob], `ticket-${o.id}.pdf`, { type: 'application/pdf' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Ticket #' + o.id, text: texto }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  descargar(blob, file.name); toast('PDF descargado. Adjúntalo en el chat de WhatsApp.');
}
function mensaje(o, tipo) {
  const cu = o.customers, pg = sum(o.payments), saldo = Math.max(0, Number(o.total) - pg);
  const M = { nuevo: `recibimos tu pedido #${o.id} por ${$$(o.total)}. Estado: ${etiqueta(o)[0]}.`,
    apartado: `tu apartado #${o.id} quedó registrado por ${$$(o.total)}. Abonado ${$$(pg)}, saldo ${$$(saldo)}.`,
    pago: `registramos tu pago en el pedido #${o.id}. Pagado ${$$(pg)}, saldo ${$$(saldo)}.`,
    listo: `tu pedido #${o.id} ya está listo.`, camino: `tu pedido #${o.id} ya va en camino.`, entregado: `tu pedido #${o.id} fue entregado. ¡Buen provecho!` };
  return `Hola${cu ? ' ' + cu.name : ''}, ${M[tipo] || M.nuevo} (${APP_CONFIG.BUSINESS_NAME || 'Tamales'})`;
}
// Aviso al cliente: ticket en PDF + mensaje por WhatsApp
function avisar(o, tipo, cat) {
  const cu = o.customers, tel = cu && cu.phone ? String(cu.phone).replace(/\D/g, '') : '', msg = mensaje(o, tipo);
  const ov = h('div', 'ov'), bx = h('div', 'box');
  const pdf = h('button', 'btn btn-acc w-100 mb-2', null, [ic('file-earmark-pdf'), '1. Compartir ticket en PDF']); pdf.onclick = () => seguro(() => compartirPDF(o, cat, msg));
  bx.append(h('h5', null, 'Avisar al cliente'), h('p', 'small text-secondary', msg), pdf);
  if (tel) {
    const a = h('a', 'btn btn-success w-100 mb-2', null, [ic('whatsapp'), '2. Enviar mensaje por WhatsApp']);
    a.href = 'https://wa.me/' + (tel.length === 10 ? (APP_CONFIG.WA_COUNTRY || '52') + tel : tel) + '?text=' + encodeURIComponent(msg); a.target = '_blank'; a.rel = 'noopener'; bx.append(a);
  } else bx.append(h('p', 'small text-danger', 'El cliente no tiene celular registrado.'));
  const no = h('button', 'btn btn-outline-secondary w-100', 'Cerrar'); no.onclick = () => ov.remove();
  bx.append(h('p', 'small text-secondary', 'WhatsApp no deja adjuntar el PDF desde un enlace: en el celular el paso 1 abre el menú de compartir; en computadora descarga el PDF para que lo adjuntes.'), no);
  ov.append(bx); document.body.append(ov);
}
