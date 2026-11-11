'use strict';
/* Módulos de negocio. Se carga antes de app.js; usa sus helpers (h, ic, st, sb, toast, confirmar, seguro, render, isAdmin, byKind, salsaName). */

const $$ = n => Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
const fdt = d => new Date(d).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const sum = a => (a || []).reduce((x, y) => x + Number(y.amount), 0);
const r2 = n => Math.round(n * 100) / 100;
const KIND = { mostrador: 'Sucursal', envio: 'Domicilio', apartado: 'Apartado' };
const DL = { por_enviar: 'Por enviar', en_camino: 'En camino', entregado: 'Entregado' };
const METODOS = [['efectivo', 'Efectivo'], ['transferencia', 'Transferencia'], ['tarjeta', 'Tarjeta']];
const CARGOS = [['cajero', 'Cajero'], ['repartidor', 'Repartidor'], ['cocinero', 'Cocinero'], ['general', 'Otro / general']];
const safe = s => /^[=+\-@]/.test(String(s)) ? "'" + s : String(s);
const badge = (t, c) => h('span', 'badge bg-' + c + ' me-1', t);
const canCash = () => isAdmin() || ['cajero', 'general'].includes(st.me.cargo);
const canKitchen = () => isAdmin() || ['cocinero', 'general'].includes(st.me.cargo);
const newCart = () => ({ items: {}, prices: {}, kind: 'mostrador', customer: '', note: '', pago: newPago(), fecha: '', estado: '', entrega: '', editing: null, back: 'caja' });
const bad = m => { const e = new Error(m); e.msg = m; return e; };
const ORD = 'id,total,status,kind,delivery,delivery_date,note,created_at,customer_id,stock_debited,created_by,assigned_to,delivered_by,customers(name,phone,colony,street,street_number,address),payments(id,amount,method,tendered,created_at,created_by),order_items(qty,unit_price,product_id)';

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
  return { txt: `${i.qty} × ${p.name}`, sub: p.is_combo ? comboTxt(cat, p) : '', unit: Number(i.unit_price), total: Number(i.unit_price) * i.qty };
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
  const S = newPago();
  const pays = await new Promise(res => {
    const ov = h('div', 'ov'), done = v => { ov.remove(); res(v); }, bx = h('div', 'box text-start'), info = h('div', 'fw-semibold mb-2'), msg = h('div', 'small text-danger');
    const upd = () => { const c = calcPago(pagosDe(S), saldo); info.textContent = c.error ? '' : (c.cambio > 0 ? `Cambio a entregar: ${$$(c.cambio)}` : `Quedará de saldo: ${$$(r2(saldo - c.ap))}`); msg.textContent = c.error || ''; };
    const ui = pagoUI(S, upd);
    const yes = h('button', 'btn btn-acc px-4', 'Cobrar'), no = h('button', 'btn btn-outline-secondary px-4', 'Cancelar'); no.onclick = () => done(null);
    yes.onclick = () => { const p = pagosDe(S), c = calcPago(p, saldo); if (!p.length) { msg.textContent = 'Escribe el monto recibido.'; return; } if (c.error) { msg.textContent = c.error; return; } done(p); };
    bx.append(h('h5', 'mb-1', `Cobrar · pedido #${o.id}`), h('p', 'small text-secondary', 'Saldo ' + $$(saldo)), ui, info, msg, h('div', 'd-flex gap-2 justify-content-center mt-2', null, [no, yes]));
    ov.append(bx); document.body.append(ov); upd();
  });
  if (!pays) return null;
  const c = calcPago(pays, saldo);
  if (!await confirmar(`¿Cobrar ${$$(c.ap)}${c.cambio > 0 ? ' y dar cambio de ' + $$(c.cambio) : ''}?`)) return null;
  await rpc('add_payment', { p_order: o.id, p_pays: pays });
  if (c.cambio > 0) msgModal('Cambio a entregar', $$(c.cambio), `Recibido ${$$(c.recibido)} · Cobrado ${$$(c.ap)}`); else toast('Pago registrado');
  if (!sinRender) { render(); avisar(await cargarPedido(o.id), 'pago', cat); }
  return c.ap;
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
  if (o.delivery_date) bx.append(h('div', 'small mt-1', null, [ic('calendar-event'), 'Entrega programada: ' + fechaLarga(o.delivery_date)]));
  bx.append(h('hr', 'my-2'));
  lineas(o, cat).forEach(l => { bx.append(h('div', 'd-flex justify-content-between', null, [h('span', null, `${l.txt} (${$$(l.unit)} c/u)`), h('span', null, $$(l.total))])); if (l.sub) bx.append(h('div', 'small text-secondary ps-2', 'Incluye: ' + l.sub)); });
  bx.append(h('hr', 'my-2'), h('div', 'd-flex justify-content-between fw-bold', null, [h('span', null, 'Total'), h('span', null, $$(o.total))]),
    h('div', 'small', `Pagado ${$$(pg)} · Saldo ${$$(Math.max(0, Number(o.total) - pg))}`));
  o.payments.forEach(p => bx.append(h('div', 'small text-secondary', `${fdt(p.created_at)} · ${p.method} · ${$$(p.amount)} · cobró ${staffName(p.created_by)}`)));
  if (o.note) bx.append(h('div', 'small fst-italic mt-1', 'Nota: ' + o.note));
  bx.append(h('div', 'small text-secondary mt-2', `Registró: ${staffName(o.created_by)} · Reparte: ${staffName(o.assigned_to)} · Entregó: ${staffName(o.delivered_by)}`));
  const tk = h('button', 'btn btn-outline-secondary w-100 mt-3', null, [ic('receipt'), 'Ver ticket']); tk.onclick = () => { ov.remove(); verTicket(o, cat); };
  const x = h('button', 'btn btn-acc w-100 mt-2', 'Cerrar'); x.onclick = () => ov.remove();
  bx.append(tk, x); ov.append(bx); document.body.append(ov);
}

/* ---------- Tarjeta de pedido con acciones según cargo ---------- */
function editar(o) {
  const items = {}, prices = {};
  (o.order_items || []).forEach(i => { items[i.product_id] = (items[i.product_id] || 0) + i.qty; prices[i.product_id] = Number(i.unit_price); });
  st.cart = { ...newCart(), items, prices, kind: o.kind, customer: o.customer_id ? String(o.customer_id) : '', note: o.note || '', fecha: o.delivery_date || '',
    entrega: o.kind === 'envio' ? 'domicilio' : 'sucursal', editing: o.id, back: st.view };
  st.view = 'caja'; render();
}
function acciones(row, o, cat, saldo) {
  const adm = isAdmin(), cg = st.me.cargo, cash = canCash(), repar = cg === 'repartidor', mio = o.assigned_to === st.me.id;
  const pagado = saldo <= 0.001, abierto = ['pendiente', 'listo'].includes(o.status), domicilio = o.kind === 'envio', enCamino = domicilio && o.delivery === 'en_camino';
  const mk = (txt, icon, fn, cls = 'btn-outline-secondary') => { const b = h('button', 'btn btn-sm ' + cls, null, [ic(icon), txt]); b.onclick = () => seguro(fn); row.append(b); };
  const set = async (status, delivery, msg, aviso) => {
    if (!await confirmar(msg)) return;
    await rpc('set_order_status', { p_order: o.id, p_status: status, p_delivery: delivery }); toast('Actualizado'); render(); if (aviso) avisar(await cargarPedido(o.id), aviso, cat);
  };
  mk('Detalle', 'list-ul', () => verDetalle(o, cat));
  if (saldo > 0.001 && abierto && (cash || (repar && mio))) mk(enCamino ? 'Cobrar en domicilio' : 'Abonar', 'cash-coin', () => abonar(o, saldo, false, cat), 'btn-acc');
  if (o.status === 'pendiente' && (adm || cash)) mk('Marcar listo', 'check2', () => set('listo', null, `¿El pedido #${o.id} está listo? Se descontarán los tamales del inventario.`, o.customer_id ? 'listo' : null));
  if (domicilio && abierto && (adm || cash)) mk(o.assigned_to ? 'Cambiar repartidor' : 'Asignar repartidor', 'person-badge', () => asignar(o));
  // Nada sale a reparto sin repartidor: si no hay uno asignado, se elige en ese momento
  if (domicilio && abierto && o.delivery === 'por_enviar' && (adm || cash || (repar && mio && o.status === 'listo')))
    mk('Salió a reparto', 'truck', async () => {
      if (!o.assigned_to) { const u = await elegirRepartidor(o); if (!u) return; await rpc('assign_order', { p_order: o.id, p_user: u }); }
      await set(o.status === 'pendiente' ? 'listo' : o.status, 'en_camino', `¿El pedido #${o.id} salió a reparto?`, 'camino');
    });
  // El repartidor registra el dinero que recibe en el domicilio antes de entregar
  if (enCamino && abierto && (adm || cash || (repar && mio)))
    mk(saldo > 0.001 ? 'Cobrar y entregar' : 'Entregado', 'box-seam', async () => {
      if (saldo > 0.001) { const ap = await abonar(o, saldo, true, cat); if (ap === null) return; if (ap < saldo - 0.001) { toast('Aún queda saldo por cobrar.', false); render(); return; } }
      await set('entregado', null, `¿Confirmas que el pedido #${o.id} fue entregado?`, 'entregado');
    }, 'btn-acc');
  if (!domicilio && abierto && pagado && (adm || cash))
    mk('Entregar en sucursal', 'shop', () => set('entregado', null, `¿Entregar el pedido #${o.id} al cliente en sucursal?`, o.customer_id ? 'entregado' : null), 'btn-acc');
  if (o.status === 'listo' && (adm || cash)) mk('Regresar a pendiente', 'arrow-counterclockwise', () => set('pendiente', null, '¿Regresar a pendiente? Los tamales vuelven al inventario.', null));
  if (o.status === 'pendiente' && cash) mk('Editar', 'pencil', () => editar(o));
  mk('Ticket', 'receipt', () => verTicket(o, cat));
}
function pedidoCard(o, cat) {
  const pg = sum(o.payments), saldo = r2(Number(o.total) - pg), [t, col] = etiqueta(o), cu = o.customers, c = h('div', 'card p-3 mb-2');
  c.append(h('div', 'd-flex justify-content-between gap-2', null, [h('strong', null, `#${o.id} · ${cu ? cu.name : 'Mostrador'}`), h('strong', null, $$(o.total))]),
    h('div', 'my-1', null, [badge(t, col), badge(KIND[o.kind], 'dark'), ...(o.status === 'listo' ? [badge('Listo', 'info')] : []), ...(o.delivery && o.status !== 'entregado' ? [badge(DL[o.delivery], 'primary')] : []),
      ...(o.kind === 'envio' && !o.assigned_to && ['pendiente', 'listo'].includes(o.status) ? [badge('Sin repartidor', 'warning')] : []),
      ...(o.delivery_date ? [badge('Entrega: ' + fechaCorta(o.delivery_date), o.delivery_date < hoyStr() && ['pendiente', 'listo'].includes(o.status) ? 'danger' : 'dark')] : [])]));
  lineas(o, cat).forEach(l => c.append(h('div', 'small', l.txt + (l.sub ? ` (${l.sub})` : ''))));
  if (o.kind !== 'mostrador' && cu) c.append(h('div', 'small text-secondary mt-1', null, [ic('geo-alt'), dirCliente(cu) + ' · ', ic('telephone'), cu.phone || 'sin celular']));
  if (o.note) c.append(h('div', 'small fst-italic', 'Nota: ' + o.note));
  c.append(h('div', 'small text-secondary', `Registró: ${staffName(o.created_by)}${o.assigned_to ? ' · Reparte: ' + staffName(o.assigned_to) : ''}${o.delivered_by ? ' · Entregó: ' + staffName(o.delivered_by) : ''}`));
  c.append(h('div', 'small mt-1', `Pagado ${$$(pg)} · Saldo ${$$(saldo)}`));
  const row = h('div', 'd-flex flex-wrap gap-2 mt-2'); acciones(row, o, cat, saldo); c.append(row); return c;
}

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
  const q = c ? sb.from('customers').update(rec).eq('id', c.id).select('id,name').single() : sb.from('customers').insert(rec).select('id,name').single();
  const { data, error } = await q; errDb(error); return data;
}
function clientes() {
  return lazy(async box => {
    const [cat, r] = await Promise.all([getCat(), sb.from('customers').select('*').order('name').limit(500)]); if (r.error) throw r.error;
    const bs = h('input', 'form-control'); bs.placeholder = 'Buscar por nombre, celular o colonia…'; bs.maxLength = 60; bs.value = st.draft.cq || '';
    const top = h('div', 'd-flex gap-2 mb-3', null, [bs]), list = h('div');
    if (canCash()) { const add = h('button', 'btn btn-acc text-nowrap', null, [ic('person-plus'), 'Nuevo']); add.onclick = () => seguro(async () => { if (await formCliente(null)) { toast('Cliente guardado'); render(); } }); top.append(add); }
    const pinta = () => {
      st.draft.cq = bs.value; const t = bs.value.trim().toLowerCase(); list.replaceChildren();
      const rows = r.data.filter(c => !t || [c.name, c.phone, c.colony, c.street].some(x => String(x || '').toLowerCase().includes(t)));
      if (!rows.length) list.append(h('p', 'text-secondary', r.data.length ? 'No hay clientes con esa búsqueda.' : 'Todavía no hay clientes.'));
      rows.forEach(c => {
        const row = h('div', 'card p-2 mb-2 d-flex flex-row align-items-center gap-2 flex-wrap', null, [h('div', 'flex-grow-1', null, [h('strong', null, c.name), h('div', 'small text-secondary', (c.phone || 'Sin celular') + ' · ' + dirCliente(c))])]);
        const hs = h('button', 'btn btn-sm btn-outline-secondary', null, [ic('clock-history'), 'Pedidos']); hs.onclick = () => seguro(() => historial(c, cat)); row.append(hs);
        if (canCash()) { const e = h('button', 'btn btn-sm btn-outline-secondary', null, [ic('pencil')]); e.title = 'Editar'; e.onclick = () => seguro(async () => { if (await formCliente(c)) { toast('Cliente actualizado'); render(); } }); row.append(e); }
        if (isAdmin()) { const d = h('button', 'btn btn-sm btn-outline-danger', null, [ic('trash')]); d.title = 'Eliminar';
          d.onclick = () => seguro(async () => { if (!await confirmar(`¿Eliminar a ${c.name}?`)) return; const { error } = await sb.from('customers').delete().eq('id', c.id);
            if (error) return toast('No se puede eliminar: tiene pedidos registrados.', false); toast('Cliente eliminado'); render(); }); row.append(d); }
        list.append(row);
      });
    };
    bs.oninput = pinta; pinta(); box.replaceChildren(top, list);
  });
}
function buscarClienteModal(clientes, actualId, onSelect) {
  const ov = h('div', 'ov'), bx = h('div', 'box text-start p-3');
  bx.style.maxWidth = '560px';

  const title = h('h5', 'mb-0', 'Seleccionar cliente');
  const close = h('button', 'btn-close ms-auto');
  close.onclick = () => ov.remove();
  const head = h('div', 'd-flex align-items-center justify-content-between mb-3', null, [title, close]);

  const qInp = h('input', 'form-control mb-2');
  qInp.placeholder = 'Buscar por nombre, celular, colonia o calle...';

  const actRow = h('div', 'd-flex gap-2 mb-2 flex-wrap');
  const btnSin = h('button', 'btn btn-sm btn-outline-secondary flex-grow-1', null, [ic('dash-circle'), ' Sin cliente (mostrador)']);
  btnSin.onclick = () => { onSelect('', null); ov.remove(); };

  const btnNuevo = h('button', 'btn btn-sm btn-acc', null, [ic('person-plus'), ' Nuevo cliente']);
  btnNuevo.onclick = () => seguro(async () => {
    ov.remove();
    const nn = await formCliente(null);
    if (nn) {
      toast('Cliente guardado');
      onSelect(String(nn.id), nn);
    }
  });
  actRow.append(btnSin, btnNuevo);

  const colonias = Array.from(new Set(clientes.map(c => (c.colony || '').trim()).filter(Boolean))).sort();
  let colFiltro = 'todas';
  const colWrap = h('div', 'd-flex gap-1 flex-wrap mb-2');
  if (colonias.length > 1) {
    const chipTodas = h('button', 'chip on py-0 px-2 small', 'Todas');
    colWrap.append(chipTodas);
    colonias.slice(0, 7).forEach(col => {
      const chip = h('button', 'chip py-0 px-2 small', col);
      chip.onclick = () => {
        colFiltro = colFiltro === col ? 'todas' : col;
        colWrap.querySelectorAll('.chip').forEach(c => c.classList.remove('on'));
        (colFiltro === 'todas' ? chipTodas : chip).classList.add('on');
        pinta();
      };
      colWrap.append(chip);
    });
    chipTodas.onclick = () => {
      colFiltro = 'todas';
      colWrap.querySelectorAll('.chip').forEach(c => c.classList.remove('on'));
      chipTodas.classList.add('on');
      pinta();
    };
  }

  const list = h('div', 'd-flex flex-column gap-2');
  list.style.maxHeight = '50vh';
  list.style.overflowY = 'auto';

  const pinta = () => {
    list.replaceChildren();
    const q = qInp.value.trim().toLowerCase();
    let rows = clientes;
    if (colFiltro !== 'todas') {
      rows = rows.filter(c => (c.colony || '').trim().toLowerCase() === colFiltro.toLowerCase());
    }
    if (q) {
      rows = rows.filter(c =>
        (c.name || '').toLowerCase().includes(q) ||
        (c.phone || '').includes(q) ||
        (c.colony || '').toLowerCase().includes(q) ||
        (c.street || '').toLowerCase().includes(q) ||
        (c.address || '').toLowerCase().includes(q)
      );
    }

    if (!rows.length) {
      list.append(h('div', 'text-center text-secondary py-3', 'No se encontraron clientes con esa búsqueda.'));
      return;
    }

    rows.forEach(c => {
      const isSel = String(c.id) === String(actualId);
      const row = h('button', 'btn btn-outline-secondary text-start p-2 d-flex align-items-center justify-content-between gap-2' + (isSel ? ' border-primary bg-primary bg-opacity-10' : ''));
      const details = h('div', 'flex-grow-1', null, [
        h('div', 'fw-bold', c.name),
        h('div', 'small text-secondary', (c.phone ? `📞 ${c.phone} · ` : '') + dirCliente(c))
      ]);
      const badgeSel = isSel
        ? h('span', 'badge bg-primary ms-2', 'Seleccionado')
        : h('span', 'badge bg-secondary-subtle text-secondary ms-2', 'Elegir');
      row.append(details, badgeSel);
      row.onclick = () => {
        onSelect(String(c.id), c);
        ov.remove();
      };
      list.append(row);
    });
  };

  qInp.oninput = pinta;
  pinta();

  bx.append(head, qInp, colWrap, actRow, list);
  ov.append(bx);
  ov.onclick = e => { if (e.target === ov) ov.remove(); };
  document.body.append(ov);
  setTimeout(() => qInp.focus(), 60);
}
async function historial(c, cat) {
  const r = await sb.from('orders').select(ORD).eq('customer_id', c.id).order('created_at', { ascending: false }).limit(100); errDb(r.error);
  const ok = r.data.filter(o => o.status !== 'cancelado'), tot = ok.reduce((a, o) => a + Number(o.total), 0), pg = ok.reduce((a, o) => a + sum(o.payments), 0);
  const ov = h('div', 'ov'), bx = h('div', 'box text-start');
  bx.append(h('h5', 'mb-1', c.name), h('div', 'small text-secondary mb-3', `${ok.length} pedidos · comprado ${$$(tot)} · pagado ${$$(pg)} · saldo ${$$(tot - pg)}`));
  if (!r.data.length) bx.append(h('p', 'text-secondary', 'Este cliente aún no tiene pedidos.'));
  r.data.forEach(o => {
    const [lab, col] = etiqueta(o);
    const b = h('button', 'btn btn-sm btn-outline-secondary w-100 text-start mb-2', null, [h('div', 'd-flex justify-content-between', null, [h('strong', null, `#${o.id} · ${fdt(o.created_at)}`), h('span', null, $$(o.total))]), h('div', 'mt-1', null, [badge(lab, col), badge(KIND[o.kind], 'dark')])]);
    b.onclick = () => verDetalle(o, cat); bx.append(b);
  });
  const x = h('button', 'btn btn-acc w-100 mt-2', 'Cerrar'); x.onclick = () => ov.remove(); bx.append(x); ov.append(bx); document.body.append(ov);
}

/* ---------- Caja ---------- */
function caja() {
  return lazy(async box => {
    const [cat, cu, lc, bus] = await Promise.all([getCat(), sb.from('customers').select('id,name,colony,street,street_number,address').order('name').limit(500),
      sb.from('cash_closures').select('*').order('to_ts', { ascending: false }).limit(5), buscarPedidos(st.draft.pq || '')]);
    for (const r of [cu, lc]) if (r.error) throw r.error;
    const from = lc.data[0] ? lc.data[0].to_ts : '2000-01-01T00:00:00Z';
    const py = await sb.from('payments').select('amount,method,orders(status)').gt('created_at', from).limit(2000); if (py.error) throw py.error;
    const C = st.cart || (st.cart = newCart()); C.prices = C.prices || {}; if (!C.pago) C.pago = newPago(); if (!C.editing) C.kind = 'mostrador';
    const prods = cat.list.filter(p => p.active || C.items[p.id]), price = p => C.prices[p.id] != null ? C.prices[p.id] : Number(p.price);
    const numIn = (val, min, max, step) => { const i = h('input', 'form-control form-control-sm qty'); i.type = 'number'; i.min = min; i.max = max; i.step = step; i.inputMode = step === 1 ? 'numeric' : 'decimal'; i.value = val; return i; };

    const buscador = () => {
      const c = h('div', 'card p-3 mb-3'), bi = h('input', 'form-control'); bi.placeholder = 'Buscar pedido: # de pedido, nombre o celular del cliente'; bi.maxLength = 60; bi.value = st.draft.pq || '';
      const go = h('button', 'btn btn-acc', null, [ic('search'), 'Buscar']), lim = h('button', 'btn btn-outline-secondary', null, [ic('x-lg')]); lim.title = 'Limpiar';
      const buscar = () => { st.draft.pq = bi.value.trim(); render(); }; go.onclick = buscar; bi.onkeydown = e => { if (e.key === 'Enter') buscar(); }; lim.onclick = () => { st.draft.pq = ''; render(); };
      c.append(h('div', 'd-flex gap-2', null, [bi, go, ...(st.draft.pq ? [lim] : [])]));
      if (st.draft.pq) { c.append(h('div', 'small text-secondary mt-2', `${bus.length} resultado(s) para "${st.draft.pq}"`)); if (!bus.length) c.append(h('div', 'small text-secondary', 'No se encontró ningún pedido.')); bus.forEach(o => c.append(h('div', 'mt-2', null, [pedidoCard(o, cat)]))); }
      return c;
    };
    const draw = () => {
      const items = prods.filter(p => C.items[p.id]), total = r2(items.reduce((a, p) => a + price(p) * C.items[p.id], 0));
      const left = h('div', 'col-lg-6'), right = h('div', 'col-lg-6');
      left.append(h('h5', null, 'Productos'));
      if (!prods.length) left.append(h('p', 'text-secondary', 'Aún no hay productos. Agrégalos en Catálogo.'));
      const grid = h('div', 'd-grid gap-2');
      prods.filter(p => p.active).forEach(p => {
        const u = imgUrl(p), img = u ? h('img', 'thumb') : h('div', 'thumb d-flex align-items-center justify-content-center bg-secondary-subtle', null, [h('i', 'bi bi-fire')]);
        if (u) { img.src = u; img.alt = ''; img.loading = 'lazy'; }
        const main = h('button', 'btn btn-outline-secondary text-start d-flex align-items-center gap-2', null, [img,
          h('div', null, null, [h('div', 'fw-bold', p.name + (p.is_combo ? ' (combo)' : '')), h('small', 'text-secondary', $$(p.price) + (p.is_combo ? ' · ' + comboTxt(cat, p) : ''))])]);
        main.onclick = () => { C.items[p.id] = Math.min(1000, (C.items[p.id] || 0) + 1); draw(); };
        const nq = h('input', 'form-control qty'); nq.type = 'number'; nq.min = 1; nq.max = 1000; nq.placeholder = 'Cant.'; nq.inputMode = 'numeric';
        const add = h('button', 'btn btn-acc', null, [h('i', 'bi bi-plus-lg')]); add.title = 'Agregar la cantidad escrita';
        add.onclick = () => { const k = Number(nq.value || 1); if (!Number.isInteger(k) || k < 1 || k > 1000) return toast('Cantidad de 1 a 1000.', false); C.items[p.id] = Math.min(1000, (C.items[p.id] || 0) + k); draw(); };
        nq.onkeydown = e => { if (e.key === 'Enter') add.click(); };
        grid.append(h('div', 'ptile', null, [main, nq, add]));
      });
      left.append(grid);

      const cart = h('div', 'card p-3');
      cart.append(h('h5', null, C.editing ? `Editando pedido #${C.editing}` : 'Venta'));
      if (C.editing) { const x = h('button', 'btn btn-sm btn-outline-secondary mb-2', 'Cancelar edición'); x.onclick = () => { const b = C.back; st.cart = newCart(); st.view = b || 'caja'; render(); }; cart.append(x); }
      if (!items.length) cart.append(h('p', 'text-secondary', 'Toca un producto, o escribe la cantidad y pulsa +.'));
      items.forEach(p => {
        const q = C.items[p.id], qi = numIn(q, 1, 1000, 1), pi = numIn(price(p), 0, 100000, '0.01');
        qi.onchange = () => { const k = Number(qi.value); if (!Number.isInteger(k) || k < 1 || k > 1000) { toast('Cantidad de 1 a 1000.', false); qi.value = C.items[p.id]; return; } C.items[p.id] = k; draw(); };
        pi.onchange = () => { const k = Number(pi.value); if (pi.value === '' || !Number.isFinite(k) || k < 0 || k > 100000) { toast('Precio de 0 a 100,000.', false); pi.value = price(p); return; } C.prices[p.id] = r2(k); draw(); };
        const rm = h('button', 'btn btn-sm btn-outline-secondary ms-auto', null, [h('i', 'bi bi-x-lg')]); rm.title = 'Quitar'; rm.onclick = () => { delete C.items[p.id]; delete C.prices[p.id]; draw(); };
        cart.append(h('div', 'mb-2 pb-2 border-bottom', null, [
          h('div', 'd-flex justify-content-between gap-2', null, [h('span', 'fw-semibold', p.name + (p.active ? '' : ' (oculto)')), h('strong', null, $$(price(p) * q))]),
          h('div', 'd-flex align-items-center gap-2 mt-1 flex-wrap', null, [h('small', 'text-secondary', 'Cant.'), qi, h('small', 'text-secondary', 'Precio'), pi,
            ...(price(p) !== Number(p.price) ? [badge('precio editado', 'info')] : []), rm])]));
      });
      const cliActual = cu.data.find(c => String(c.id) === String(C.customer));
      const cliBox = h('div', 'my-2');
      const abrirSelector = () => buscarClienteModal(cu.data, C.customer, (id, c) => {
        C.customer = id;
        draw();
      });

      if (!cliActual) {
        const btnBuscar = h('button', 'btn btn-outline-secondary flex-grow-1 text-start d-flex align-items-center justify-content-between p-2');
        btnBuscar.append(
          h('span', 'text-secondary d-flex align-items-center gap-2 text-truncate me-2', null, [ic('search'), h('span', 'text-truncate', 'Seleccionar cliente (o dejar mostrador)')]),
          h('span', 'badge bg-secondary-subtle text-secondary flex-shrink-0', 'Opcional')
        );
        btnBuscar.onclick = abrirSelector;

        const btnNuevo = h('button', 'btn btn-outline-secondary flex-shrink-0 d-flex align-items-center justify-content-center px-3', null, [ic('person-plus')]);
        btnNuevo.title = 'Nuevo cliente';
        btnNuevo.onclick = () => seguro(async () => {
          const nn = await formCliente(null);
          if (nn) { C.customer = String(nn.id); toast('Cliente guardado'); render(); }
        });

        cliBox.append(h('div', 'input-group flex-nowrap', null, [btnBuscar, btnNuevo]));
      } else {
        const selCard = h('div', 'card p-2 d-flex flex-row align-items-center gap-2 border-primary-subtle bg-primary bg-opacity-10');
        const info = h('div', 'flex-grow-1 text-truncate', null, [
          h('div', 'fw-bold text-truncate', [ic('person-fill'), ' ' + cliActual.name]),
          h('div', 'small text-secondary text-truncate', `${cliActual.phone || 'Sin cel'} · ${dirCliente(cliActual)}`)
        ]);
        const btnCambiar = h('button', 'btn btn-sm btn-outline-secondary', null, [ic('search')]);
        btnCambiar.title = 'Cambiar cliente';
        btnCambiar.onclick = abrirSelector;

        const btnQuitar = h('button', 'btn btn-sm btn-outline-danger', null, [ic('x-lg')]);
        btnQuitar.title = 'Quitar cliente (dejar sin cliente)';
        btnQuitar.onclick = () => { C.customer = ''; draw(); };

        selCard.append(info, btnCambiar, btnQuitar);
        cliBox.append(selCard);
      }

      const note = h('input', 'form-control mb-2'); note.placeholder = 'Nota (opcional)'; note.maxLength = 200; note.value = C.note; note.oninput = () => { C.note = note.value; };
      cart.append(cliBox, note);

      const defs = ESTADOS.mostrador, hint = h('div', 'small fw-semibold mt-1'), chg = h('div', 'fs-5 mt-1');
      const entregaYa = () => (defs.find(x => x[0] === C.estado) || [])[2] === 1;
      const upd = () => {
        const d = defs.find(x => x[0] === C.estado), c = calcPago(pagosDe(C.pago), total), er = d && !c.error ? validaEstado(d[1], c.ap, total) : '';
        chg.textContent = c.error ? c.error : (c.cambio > 0 ? `Cambio a entregar: ${$$(c.cambio)}` : `Falta por pagar: ${$$(r2(total - c.ap))}`);
        hint.textContent = !d ? 'Elige el estado de la venta.' : er || 'Quedará como: ' + C.estado;
        hint.className = 'small fw-semibold mt-1 ' + (!d ? 'text-secondary' : er ? 'text-danger' : 'text-success');
      };
      if (!C.editing) {
        const es = h('select', 'form-select mb-2'); es.append(Object.assign(h('option', null, '— Estado de la venta —'), { value: '' }));
        defs.forEach(d => es.append(Object.assign(h('option', null, d[0]), { value: d[0] }))); es.value = C.estado; es.onchange = () => { C.estado = es.value; draw(); };
        cart.append(es, pagoUI(C.pago, upd), chg, hint);
      }
      if (C.editing || (C.estado && !entregaYa())) {
        const en = h('select', 'form-select mb-1'); en.append(Object.assign(h('option', null, '— ¿Dónde se entrega? —'), { value: '' }));
        [['sucursal', 'En sucursal (queda en Apartados)'], ['domicilio', 'A domicilio (va a Envíos)']].forEach(([v, l]) => en.append(Object.assign(h('option', null, l), { value: v }))); en.value = C.entrega; en.onchange = () => { C.entrega = en.value; draw(); };
        const pagoOk = calcPago(pagosDe(C.pago), total).ap >= total && total > 0;
        cart.append(h('label', 'small text-secondary mt-2', 'Entrega'), en, ...(C.entrega ? [h('div', 'small text-secondary mb-1', C.entrega === 'sucursal' ? 'Pasará a Apartados hasta entregarlo en sucursal.' :
          (pagoOk || C.editing ? 'Pasará a Envíos, en espera de asignar repartidor.' : 'Con saldo pendiente: estará en Apartados hasta que esté listo; después pasa a Envíos y el repartidor cobra en el domicilio.'))] : []));
        const fd = h('input', 'form-control mb-2'); fd.type = 'date'; fd.min = hoyStr(); fd.value = C.fecha; fd.onchange = () => { C.fecha = fd.value; };
        cart.append(h('label', 'small text-secondary mt-1', 'Fecha de entrega'), fd);
      }
      upd();
      const payload = () => items.map(p => ({ product_id: p.id, qty: C.items[p.id], price: price(p) }));
      const go = h('button', 'btn btn-acc btn-lg w-100 mt-3', null, [ic('check2-circle'), (C.editing ? 'Guardar cambios · ' : 'Guardar pedido · ') + $$(total)]);
      go.onclick = () => seguro(async () => {
        if (!items.length) return toast('Agrega al menos un producto.', false);
        if (C.editing) {
          if (!C.customer) return toast('Los pedidos por entregar necesitan cliente.', false);
          if (!C.entrega) return toast('Elige si se entrega en sucursal o a domicilio.', false);
          const kindE = C.entrega === 'domicilio' ? 'envio' : (C.kind === 'envio' ? 'mostrador' : C.kind), cliE = cu.data.find(x => String(x.id) === C.customer);
          if (kindE === 'envio' && !(cliE && ((cliE.street && cliE.colony && cliE.street_number) || cliE.address))) return toast('El cliente no tiene dirección completa. Edítalo en Clientes.', false);
          if (!await confirmar(`¿Guardar los cambios del pedido #${C.editing}?`)) return;
          await rpc('update_order', { p_order: C.editing, p_customer: Number(C.customer), p_kind: kindE, p_note: C.note || null, p_items: payload(), p_delivery_date: C.fecha || null });
          const b = C.back; st.cart = newCart(); st.view = b || 'caja'; toast('Pedido actualizado'); render(); return;
        }
        const d = defs.find(x => x[0] === C.estado); if (!d) return toast('Elige el estado de la venta.', false);
        const ya = d[2] === 1;
        if (!ya && !C.customer) return toast('Los pedidos por entregar necesitan cliente.', false);
        if (!ya && !C.entrega) return toast('Elige si se entrega en sucursal o a domicilio.', false);
        const cli = cu.data.find(x => String(x.id) === C.customer);
        if (!ya && C.entrega === 'domicilio' && !(cli && ((cli.street && cli.colony && cli.street_number) || cli.address))) return toast('El cliente no tiene dirección completa (colonia, calle y número). Edítalo en Clientes.', false);
        if (!ya && !C.fecha) return toast('Elige la fecha de entrega.', false);
        if (!ya && C.fecha < hoyStr()) return toast('La fecha de entrega no puede ser anterior a hoy.', false);
        const pays = pagosDe(C.pago), c = calcPago(pays, total); if (c.error) return toast(c.error, false);
        const er = validaEstado(d[1], c.ap, total); if (er) return toast(er, false);
        if (!await confirmar(`¿Guardar como ${C.estado} por ${$$(total)}${c.ap ? ' con pago de ' + $$(c.ap) : ''}${ya ? '' : ' ' + (ya ? '' : (C.entrega === 'domicilio' ? ' a domicilio' : ' en sucursal')) + (ya ? '' : ' el ' + C.fecha)}?`)) return;
        const oid = await rpc('create_order', { p_customer: C.customer ? Number(C.customer) : null, p_kind: !ya && C.entrega === 'domicilio' ? 'envio' : 'mostrador', p_note: C.note || null, p_items: payload(), p_pays: pays, p_deliver: ya, p_delivery_date: ya ? null : C.fecha });
        st.cart = newCart(); render(); verTicket(await cargarPedido(oid), cat, 'nuevo');
        if (c.cambio > 0) msgModal('Cambio a entregar', $$(c.cambio), `Recibido ${$$(c.recibido)} · Cuenta ${$$(total)}`);
      });
      cart.append(go); right.append(cart);

      const pays = py.data.filter(p => !p.orders || p.orders.status !== 'cancelado'), por = m => pays.filter(p => p.method === m).reduce((a, p) => a + Number(p.amount), 0);
      const ct = h('div', 'card p-3 mt-4'); ct.append(h('h5', null, null, [ic('scissors'), 'Corte de caja']),
        h('p', 'mb-2', `Desde el último corte: Efectivo ${$$(por('efectivo'))} · Transferencia ${$$(por('transferencia'))} · Tarjeta ${$$(por('tarjeta'))} · Total ${$$(por('efectivo') + por('transferencia') + por('tarjeta'))}`));
      const cb = h('button', 'btn btn-outline-secondary', null, [ic('scissors'), 'Hacer corte ahora']);
      cb.onclick = () => seguro(async () => { if (!await confirmar('¿Hacer el corte de caja con estos totales?')) return; await rpc('close_cash'); toast('Corte guardado'); render(); });
      ct.append(cb);
      lc.data.forEach(k => {
        const row = h('div', 'small d-flex align-items-center gap-2 mt-2 flex-wrap', null, [h('span', 'flex-grow-1', `${fdt(k.to_ts)} · Efvo ${$$(k.efectivo)} · Transf ${$$(k.transferencia)} · Tarj ${$$(k.tarjeta)}`)]);
        if (isAdmin()) { const d = h('button', 'btn btn-sm btn-outline-danger', null, [ic('trash')]); d.title = 'Eliminar corte';
          d.onclick = () => seguro(async () => { if (!await confirmar('¿Eliminar este corte? No se puede deshacer.')) return; const { error } = await sb.from('cash_closures').delete().eq('id', k.id); errDb(error); toast('Corte eliminado'); render(); });
          row.append(d); }
        ct.append(row);
      });
      box.replaceChildren(buscador(), h('div', 'row g-3', null, [left, right]), ct);
    };
    draw();
  });
}

/* ---------- Ventas ---------- */
function ventasLista() {
  return lazy(async box => {
    const F = st.vf || (st.vf = { desde: hoyStr(), hasta: hoyStr(), est: 'todos', tipo: '', reg: '', rep: '', all: false });
    let q = sb.from('orders').select(ORD + ',order_tamales(salsa_id,qty)').order('created_at', { ascending: false }).limit(1000);
    if (!F.all) { const [a, b] = rango(F.desde, F.hasta); q = q.gte('created_at', a).lt('created_at', b); }
    if (F.tipo) q = q.eq('kind', F.tipo);
    if (F.reg) q = q.eq('created_by', F.reg);
    if (F.rep) q = F.rep === 'none' ? q.is('assigned_to', null) : q.eq('assigned_to', F.rep);
    const [cat, r] = await Promise.all([getCat(), q]); if (r.error) throw r.error;
    const saldoDe = o => Number(o.total) - sum(o.payments), pend = o => ['pendiente', 'listo'].includes(o.status);
    const FIL = { todos: () => true, cobrar: o => o.status !== 'cancelado' && saldoDe(o) > 0.001, entregar: pend,
      pendientes: o => o.status !== 'cancelado' && (saldoDe(o) > 0.001 || pend(o)), cerrados: o => o.status === 'entregado' && saldoDe(o) <= 0.001, cancelados: o => o.status === 'cancelado' };
    const data = r.data.filter(FIL[F.est] || FIL.todos), ok = data.filter(o => o.status !== 'cancelado');

    // Filtros
    const sel = (opts, val, fn) => { const s = h('select', 'form-select form-select-sm w-auto'); opts.forEach(([v, l]) => s.append(Object.assign(h('option', null, l), { value: v }))); s.value = val; s.onchange = () => { fn(s.value); render(); }; return s; };
    const todos = staffArr(), reps = todos.filter(x => x.cargo === 'repartidor');
    const fechas = filtroFechas(F);
    const allc = h('button', 'chip' + (F.all ? ' on' : ''), 'Todas las fechas'); allc.onclick = () => { F.all = !F.all; render(); }; fechas.append(allc);
    const filtros = h('div', 'd-flex flex-wrap gap-2 align-items-center mb-3', null, [
      sel([['todos', 'Todos los estados'], ['pendientes', 'Pendientes (cobrar o entregar)'], ['cobrar', 'Por cobrar'], ['entregar', 'Por entregar'], ['cerrados', 'Pagados y entregados'], ['cancelados', 'Cancelados']], F.est, v => { F.est = v; }),
      sel([['', 'Todos los tipos'], ['mostrador', 'Sucursal'], ['envio', 'Domicilio'], ['apartado', 'Apartado']], F.tipo, v => { F.tipo = v; }),
      sel([['', 'Registró: todos'], ...todos.map(x => [x.id, x.full_name])], F.reg, v => { F.reg = v; }),
      sel([['', 'Repartidor: todos'], ['none', 'Sin asignar'], ...reps.map(x => [x.id, x.full_name])], F.rep, v => { F.rep = v; })]);

    // Métricas
    const vendido = ok.reduce((a, o) => a + Number(o.total), 0), cobrado = ok.reduce((a, o) => a + sum(o.payments), 0);
    const tamalesN = ok.reduce((a, o) => a + (o.order_tamales || []).reduce((s, t) => s + t.qty, 0), 0);
    const stat = (l, v) => h('div', 'col-6 col-md-4', null, [h('div', 'card p-3 text-center h-100', null, [h('div', 'fs-4 fw-bold acc', v), h('small', 'text-secondary', l)])]);
    const cards = h('div', 'row g-2 mb-3', null, [stat('Total vendido', $$(vendido)), stat('Cobrado', $$(cobrado)), stat('Por cobrar', $$(vendido - cobrado)),
      stat('Ventas', String(ok.length)), stat('Ticket promedio', $$(ok.length ? vendido / ok.length : 0)), stat('Tamales vendidos', tamalesN.toLocaleString('es-MX'))]);
    const nm = new Map(); ok.forEach(o => { if (o.customer_id && o.customers) nm.set(o.customer_id, o.customers.name); });
    const pagos = ok.flatMap(o => o.payments);
    const sabores = new Map(); ok.forEach(o => (o.order_tamales || []).forEach(t => sabores.set(t.salsa_id, (sabores.get(t.salsa_id) || 0) + t.qty)));
    const dias = agg(ok, o => ymd(new Date(o.created_at)), o => Number(o.total)).sort((a, b) => a[0] < b[0] ? -1 : 1);
    const grid = h('div', 'row g-3 mb-4', null, [
      barras('Por tipo de venta', agg(ok, o => KIND[o.kind], o => Number(o.total)), $$),
      barras('Formas de pago', agg(pagos, p => p.method, p => Number(p.amount)), $$),
      barras('Tamales por sabor', [...sabores].map(([id, v]) => [salsaName(id), v]).sort((a, b) => b[1] - a[1]), v => v.toLocaleString('es-MX')),
      barras('Productos más vendidos (unidades)', agg(ok.flatMap(o => o.order_items), i => (cat.prods.get(i.product_id) || { name: '?' }).name, i => i.qty), v => v.toLocaleString('es-MX')),
      barras('Clientes que más pagaron', agg(ok.filter(o => o.customer_id), o => nm.get(o.customer_id), o => sum(o.payments)), $$, 5),
      barras('Ventas por empleado (quién registró)', agg(ok, o => staffName(o.created_by), o => Number(o.total)), $$),
      barras('Ventas por día', dias, $$, 31)].map(c => h('div', 'col-lg-6', null, [c])));

    // Tabla
    const ex = h('button', 'btn btn-outline-success', null, [ic('file-earmark-excel'), 'Exportar a Excel']);
    ex.onclick = () => seguro(async () => {
      if (typeof XLSX === 'undefined') return toast('No se cargó la librería de Excel.', false);
      if (!await confirmar('¿Descargar estas ventas en Excel?')) return;
      const rows = [['#', 'Fecha', 'Cliente', 'Tipo', 'Estado', 'Fecha de entrega', 'Registró', 'Repartidor', 'Entregó', 'Productos', 'Total', 'Pagado', 'Saldo']].concat(data.map(o => {
        const pg = sum(o.payments); return [o.id, fdt(o.created_at), safe(o.customers ? o.customers.name : 'Mostrador'), KIND[o.kind], etiqueta(o)[0], o.delivery_date || '', staffName(o.created_by), staffName(o.assigned_to), staffName(o.delivered_by),
          safe(lineas(o, cat).map(l => l.txt).join('; ')), Number(o.total), pg, o.status === 'cancelado' ? 0 : Number(o.total) - pg]; }));
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Ventas');
      XLSX.writeFile(wb, `ventas_${new Date().toISOString().slice(0, 10)}.xlsx`); logEv('exportar', 'Ventas: ' + data.length + ' pedidos');
    });
    const tbl = h('table', 'table table-sm align-middle');
    tbl.append(h('thead', null, null, [h('tr', null, null, ['#', 'Fecha', 'Cliente', 'Estado', 'Total', ''].map(x => h('th', null, x)))]));
    const tb = h('tbody');
    data.forEach(o => {
      const cancel = o.status === 'cancelado', [lab, col] = etiqueta(o), act = h('td', 'text-nowrap');
      const dt = h('button', 'btn btn-sm btn-outline-secondary me-1', null, [ic('list-ul')]); dt.title = 'Ver detalle'; dt.onclick = () => verDetalle(o, cat); act.append(dt);
      const tk = h('button', 'btn btn-sm btn-outline-secondary me-1', null, [ic('receipt')]); tk.title = 'Ticket'; tk.onclick = () => verTicket(o, cat); act.append(tk);
      if (isAdmin()) {
        if (!cancel) { const c = h('button', 'btn btn-sm btn-outline-warning me-1', null, [ic('x-circle')]); c.title = 'Cancelar venta';
          c.onclick = () => seguro(async () => { if (!await confirmar(`¿Cancelar la venta #${o.id}?`)) return; await rpc('cancel_order', { p_order: o.id }); toast('Venta cancelada'); render(); }); act.append(c); }
        const d = h('button', 'btn btn-sm btn-outline-danger', null, [ic('trash')]); d.title = 'Eliminar venta';
        d.onclick = () => seguro(async () => { if (!await confirmar(`¿Eliminar definitivamente la venta #${o.id} y sus abonos?`)) return; const { error } = await sb.from('orders').delete().eq('id', o.id); errDb(error); toast('Venta eliminada'); render(); }); act.append(d);
      }
      tb.append(h('tr', cancel ? 'opacity-50' : '', null, [h('td', null, String(o.id)), h('td', null, fdt(o.created_at)),
        h('td', null, null, [h('div', null, o.customers ? o.customers.name : 'Mostrador'), h('div', 'small text-secondary', `Registró: ${staffName(o.created_by)}${o.assigned_to ? ' · Reparte: ' + staffName(o.assigned_to) : ''}`)]),
        h('td', null, null, [badge(lab, col)]), h('td', null, $$(o.total)), act]));
    });
    tbl.append(tb);
    box.replaceChildren(h('h5', null, 'Ventas'), fechas, filtros, cards, grid, h('div', 'd-flex align-items-center mb-2', null, [h('h6', 'mb-0 flex-grow-1', `Pedidos (${data.length})`), ex]),
      r.data.length >= 1000 ? h('p', 'small text-danger', 'Se muestran los primeros 1000: acota las fechas para ver todo.') : '',
      data.length ? h('div', 'table-responsive', null, [tbl]) : h('p', 'text-secondary', 'No hay pedidos con estos filtros.'));
  });
}

/* ---------- Tamales (antes "Hoy"): inventario y ollas ---------- */
function tamales() {
  return lazy(async box => {
    const T = st.tf || (st.tf = { desde: hoyStr(), hasta: hoyStr() }), [a, b] = rango(T.desde, T.hasta);
    const [res, r] = await Promise.all([rpc('tamales_resumen'), sb.from('batches').select('id,qty,created_at,salsa_id,created_by').gte('created_at', a).lt('created_at', b).order('created_at', { ascending: false }).limit(1000)]);
    if (r.error) throw r.error;
    const hechos = new Map(); r.data.forEach(x => hechos.set(x.salsa_id, (hechos.get(x.salsa_id) || 0) + x.qty));
    const total = r.data.reduce((s, x) => s + x.qty, 0);
    box.replaceChildren(h('h5', null, 'Tamales'), filtroFechas(T),
      h('div', 'card p-3 mb-3 text-center', null, [h('div', 'big', total.toLocaleString('es-MX')), h('div', null, T.desde === T.hasta ? `tamales hechos el ${T.desde}` : `tamales hechos del ${T.desde} al ${T.hasta}`)]),
      h('h6', null, 'Por sabor e inventario actual'));
    const row = h('div', 'row g-2 mb-3');
    res.forEach(s => {
      const falta = Math.max(0, s.pendiente - s.stock);
      row.append(h('div', 'col-6 col-md-4', null, [h('div', 'card p-2 text-center h-100', null, [h('strong', null, s.name), h('div', 'fs-3 fw-bold', String(hechos.get(s.salsa_id) || 0)), h('small', null, 'hechos en el rango'),
        h('small', 'text-secondary', `Disponibles ahora: ${s.stock}`), h('small', 'text-secondary', `Por surtir: ${s.pendiente}`), falta > 0 ? h('small', 'text-danger fw-bold', `Faltan ${falta}`) : h('small', 'text-success', 'Alcanza')])]));
    });
    box.append(row, h('h6', null, 'Ollas del rango'));
    if (!r.data.length) box.append(h('p', 'text-secondary', 'No hay ollas registradas en estas fechas.'));
    r.data.slice(0, 80).forEach(b => {
      const line = h('div', 'card p-2 mb-2 d-flex flex-row align-items-center gap-2 flex-wrap', null, [h('span', 'flex-grow-1', `${fdt(b.created_at)} · ${b.qty} de ${salsaName(b.salsa_id)} · ${staffName(b.created_by)}`)]);
      if (canKitchen()) {
        const e = h('button', 'btn btn-sm btn-outline-secondary', null, [ic('pencil')]); e.title = 'Corregir';
        e.onclick = () => seguro(async () => {
          const f = await formModal('Corregir olla', [{ key: 'q', label: 'Cantidad de tamales', type: 'number', min: 1, mode: 'numeric', value: b.qty },
            { key: 's', label: 'Sabor', options: byKind('salsa').map(s => [String(s.id), s.name]), value: String(b.salsa_id) }], 'Guardar');
          if (!f) return; const q = Number(f.q);
          if (!Number.isInteger(q) || q < 1 || q > 500) return toast('La cantidad debe ser un entero de 1 a 500.', false);
          if (!await confirmar(`¿Cambiar esta olla a ${q} de ${salsaName(Number(f.s))}?`)) return;
          const { error } = await sb.from('batches').update({ qty: q, salsa_id: Number(f.s) }).eq('id', b.id); errDb(error); toast('Olla corregida'); render();
        });
        const d = h('button', 'btn btn-sm btn-outline-danger', null, [ic('trash')]); d.title = 'Eliminar';
        d.onclick = () => seguro(async () => { if (!await confirmar('¿Eliminar esta olla? Se descontará del inventario.')) return;
          const { error } = await sb.from('batches').delete().eq('id', b.id); errDb(error); toast('Olla eliminada'); render(); });
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
    const lim = h('div', 'card p-3'); lim.append(h('h6', null, 'Liberar espacio'),
      h('div', 'alert alert-warning small', null, [ic('exclamation-triangle'), 'Borrar es definitivo. Por seguridad, antes de eliminar se descarga un Excel con toda la información que se va a borrar.']));
    [['ollas', 'registros de cocina (ollas)'], ['ventas', 'ventas entregadas y pagadas, o canceladas']].forEach(([t, l]) => {
      const sel = h('select', 'form-select w-auto'); [30, 90, 180, 365].forEach(d => sel.append(Object.assign(h('option', null, 'con más de ' + d + ' días'), { value: d })));
      const b = h('button', 'btn btn-outline-danger', null, [ic('file-earmark-excel'), 'Exportar y eliminar']);
      b.onclick = () => seguro(() => borrarConExcel(t, l, Number(sel.value)));
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
  add(`Pedido #${o.id}`); add(fdt(o.created_at)); add('Tipo: ' + KIND[o.kind]); if (o.delivery_date) add('Entrega: ' + fechaCorta(o.delivery_date)); if (o.created_by && staffName(o.created_by) !== '—') add('Atendió: ' + staffName(o.created_by));
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

/* ---------- Personal, fechas y métricas ---------- */
const staffArr = () => [...(st.staff || new Map()).values()];
const staffName = id => (id && st.staff && st.staff.get(id) ? st.staff.get(id).full_name : '—');
const ymd = d => { const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000); return z.toISOString().slice(0, 10); };
const hoyStr = () => ymd(new Date());
const diasAtras = k => { const d = new Date(); d.setDate(d.getDate() - k); return ymd(d); };
const rango = (a, b) => [new Date(a + 'T00:00:00').toISOString(), new Date(new Date(b + 'T00:00:00').getTime() + 86400000).toISOString()];
function filtroFechas(F) {
  const row = h('div', 'd-flex flex-wrap gap-2 align-items-center mb-3');
  [['Hoy', 0, 0], ['Ayer', 1, 1], ['7 días', 6, 0], ['30 días', 29, 0]].forEach(([l, a, b]) => {
    const c = h('button', 'chip' + (!F.all && F.desde === diasAtras(a) && F.hasta === diasAtras(b) ? ' on' : ''), l);
    c.onclick = () => { F.desde = diasAtras(a); F.hasta = diasAtras(b); F.all = false; render(); }; row.append(c);
  });
  const mk = (k, t) => { const i = h('input', 'form-control form-control-sm w-auto'); i.type = 'date'; i.value = F[k]; i.max = hoyStr(); i.title = t;
    i.onchange = () => { if (!i.value) return; F[k] = i.value; if (F.desde > F.hasta) { if (k === 'desde') F.hasta = F.desde; else F.desde = F.hasta; } F.all = false; render(); }; return i; };
  row.append(h('span', 'small text-secondary ms-2', 'Del'), mk('desde', 'Desde'), h('span', 'small text-secondary', 'al'), mk('hasta', 'Hasta'));
  return row;
}
const agg = (arr, key, val) => { const m = new Map(); arr.forEach(x => { const k = key(x); if (k == null) return; m.set(k, (m.get(k) || 0) + val(x)); }); return [...m].sort((a, b) => b[1] - a[1]); };
function barras(titulo, filas, fmt = String, max = 8) {
  const card = h('div', 'card p-3 h-100'); card.append(h('h6', 'mb-2', titulo));
  if (!filas.length) card.append(h('div', 'small text-secondary', 'Sin datos'));
  const mx = Math.max(...filas.map(f => f[1]), 1);
  filas.slice(0, max).forEach(([l, v]) => {
    const bar = h('div', 'bar'); bar.style.width = (v / mx * 100) + '%';
    card.append(h('div', 'mb-2', null, [h('div', 'd-flex justify-content-between small', null, [h('span', null, l), h('strong', null, fmt(v))]), h('div', 'bar-bg', null, [bar])]));
  });
  return card;
}
async function elegirRepartidor(o) {
  const reps = staffArr().filter(x => x.cargo === 'repartidor' && x.active);
  if (!reps.length) { toast('No hay repartidores activos. Crea un usuario con cargo Repartidor.', false); return null; }
  if (reps.length === 1) return (await confirmar(`¿Asignar el pedido #${o.id} a ${reps[0].full_name}?`)) ? reps[0].id : null;
  const f = await formModal(`¿Quién reparte el pedido #${o.id}?`, [{ key: 'u', label: 'Repartidor', options: [['', '— Elige un repartidor —'], ...reps.map(x => [x.id, x.full_name])], value: o.assigned_to || '' }], 'Asignar');
  if (!f) return null; if (!f.u) { toast('Elige un repartidor.', false); return null; } return f.u;
}
async function asignar(o) { const u = await elegirRepartidor(o); if (!u) return; await rpc('assign_order', { p_order: o.id, p_user: u }); toast('Repartidor asignado'); render(); }

/* ---------- Excel, bitácora y exportar antes de borrar ---------- */
const logEv = (a, d) => sb.rpc('log_event', { p_action: a, p_detail: d }).then(() => {}, () => {});
function xlsx(nombre, hoja, filas) {
  if (typeof XLSX === 'undefined') throw bad('No se cargó la librería de Excel.');
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(filas), hoja.slice(0, 31));
  XLSX.writeFile(wb, `${nombre}_${new Date().toISOString().slice(0, 10)}.xlsx`);
}
async function traer(mk, tope = 20000) {
  const out = [];
  for (let i = 0; i < tope; i += 1000) { const { data, error } = await mk().range(i, i + 999); errDb(error); out.push(...data); if (data.length < 1000) break; }
  return out;
}
async function borrarConExcel(t, l, dias) {
  const corte = new Date(Date.now() - dias * 86400000).toISOString(); let filas, nombre;
  if (t === 'ollas') {
    const rows = await traer(() => sb.from('batches').select('id,qty,created_at,salsa_id,created_by').lt('created_at', corte).order('created_at').order('id'));
    filas = [['Fecha', 'Sabor', 'Cantidad', 'Registró']].concat(rows.map(b => [fdt(b.created_at), salsaName(b.salsa_id), b.qty, staffName(b.created_by)])); nombre = 'ollas_eliminadas';
  } else {
    const [cat, rows] = await Promise.all([getCat(), traer(() => sb.from('orders').select(ORD).in('status', ['entregado', 'cancelado']).lt('created_at', corte).order('created_at').order('id'))]);
    const ok = rows.filter(o => o.status === 'cancelado' || Number(o.total) - sum(o.payments) <= 0.001);
    filas = [['#', 'Fecha', 'Cliente', 'Tipo', 'Estado', 'Fecha de entrega', 'Registró', 'Repartidor', 'Entregó', 'Productos', 'Pagos', 'Total', 'Pagado']].concat(ok.map(o => [o.id, fdt(o.created_at),
      safe(o.customers ? o.customers.name : 'Mostrador'), KIND[o.kind], etiqueta(o)[0], o.delivery_date || '', staffName(o.created_by), staffName(o.assigned_to), staffName(o.delivered_by),
      safe(lineas(o, cat).map(x => x.txt).join('; ')), o.payments.map(p => `${p.method} ${p.amount}`).join('; '), Number(o.total), sum(o.payments)])); nombre = 'ventas_eliminadas';
  }
  const n = filas.length - 1;
  if (n <= 0) return toast('No hay registros que borrar con ese criterio.', false);
  if (n >= 20000) return toast('Son demasiados registros para exportar de una vez: elige un periodo más corto.', false);
  if (!await confirmar(`Se van a BORRAR ${n} ${l} con más de ${dias} días. Antes se descargará un Excel con esa información. ¿Continuar?`)) return;
  xlsx(nombre, 'Respaldo', filas); logEv('exportar', `Respaldo antes de borrar: ${n} ${l}`);
  if (!await confirmar(`El Excel ya se descargó. Revisa que abra bien. ¿Eliminar definitivamente ${n} ${l}? No se puede deshacer.`)) return;
  const b = await rpc('purge_data', { p_target: t, p_days: dias }); toast(`${b} registros eliminados`); render();
}

/* ---------- Pagos combinados ---------- */
const METODOS_C = [...METODOS, ['combinado', 'Combinado (varios métodos)']];
const newPago = () => ({ method: 'efectivo', paid: '', mix: { efectivo: '', transferencia: '', tarjeta: '' } });
function pagosDe(S) {
  const num = x => { const v = Number(x); return Number.isFinite(v) && v > 0 ? r2(v) : 0; };
  if (S.method === 'combinado') return METODOS.map(([m]) => ({ method: m, amount: num(S.mix[m]) })).filter(p => p.amount > 0);
  const a = num(S.paid); return a > 0 ? [{ method: S.method, amount: a }] : [];
}
// Misma regla que el servidor: tarjeta/transferencia no dan cambio; el cambio sale solo del efectivo
function calcPago(pays, owed) {
  const cash = pays.filter(p => p.method === 'efectivo').reduce((a, p) => a + p.amount, 0), nonc = pays.filter(p => p.method !== 'efectivo').reduce((a, p) => a + p.amount, 0);
  if (nonc > owed + 0.001) return { error: 'Tarjeta y transferencia no pueden superar lo que se debe (' + $$(owed) + ').' };
  const apCash = Math.min(cash, Math.max(0, owed - nonc));
  if (cash > 0 && apCash <= 0) return { error: 'El efectivo no hace falta: ya está cubierto con otros métodos.' };
  return { error: '', ap: r2(nonc + apCash), cambio: r2(cash - apCash), recibido: r2(cash + nonc) };
}
function pagoUI(S, onChange) {
  const box = h('div', 'mb-2'), met = h('select', 'form-select mb-2'), body = h('div');
  METODOS_C.forEach(([v, l]) => met.append(Object.assign(h('option', null, l), { value: v }))); met.value = S.method;
  const num = (ph, get, set) => { const i = h('input', 'form-control'); i.type = 'number'; i.min = 0; i.step = '0.01'; i.inputMode = 'decimal'; i.placeholder = ph; i.value = get(); i.oninput = () => { set(i.value); onChange(); }; return i; };
  const draw = () => {
    body.replaceChildren();
    if (S.method === 'combinado') body.append(h('div', 'small text-secondary mb-1', 'Escribe cuánto paga con cada método (deja vacío el que no use).'),
      h('div', 'row g-2', null, METODOS.map(([m, l]) => h('div', 'col-12 col-sm-4', null, [h('label', 'small text-secondary', l), num('$0.00', () => S.mix[m], v => { S.mix[m] = v; })]))));
    else body.append(num('Recibido (pago / abono)', () => S.paid, v => { S.paid = v; }));
  };
  met.onchange = () => { S.method = met.value; draw(); onChange(); };
  draw(); box.append(met, body); return box;
}

/* ---------- Apartados y Envíos (derivados del estado de pago) ---------- */
const saldoDe = o => Number(o.total) - sum(o.payments);
function listaPedidos(titulo, vacio, filtro, conRepartidor) {
  return lazy(async box => {
    const [cat, r] = await Promise.all([getCat(), sb.from('orders').select(ORD).in('status', ['pendiente', 'listo']).order('delivery_date', { ascending: true, nullsFirst: false }).order('created_at').limit(300)]);
    if (r.error) throw r.error;
    const F = st.draft, reps = staffArr().filter(x => x.cargo === 'repartidor'); box.replaceChildren(h('h5', null, titulo));
    if (conRepartidor && st.me.cargo !== 'repartidor') {
      const sel = h('select', 'form-select w-auto mb-3');
      [['', 'Todos los repartidores'], ['none', 'Sin asignar'], ...reps.map(x => [x.id, x.full_name])].forEach(([v, l]) => sel.append(Object.assign(h('option', null, l), { value: v })));
      sel.value = F.rep || ''; sel.onchange = () => { F.rep = sel.value; render(); }; box.append(sel);
    }
    const data = r.data.filter(filtro).filter(o => !conRepartidor || st.me.cargo === 'repartidor' || !F.rep || (F.rep === 'none' ? !o.assigned_to : o.assigned_to === F.rep));
    const tam = data.reduce((s, o) => s + (o.order_items || []).reduce((x, i) => x + i.qty, 0), 0);
    if (!data.length) box.append(h('p', 'text-secondary', vacio)); else box.append(h('p', 'small text-secondary', `${data.length} pedidos`));
    data.forEach(o => box.append(pedidoCard(o, cat)));
  });
}
// A domicilio -> Envíos cuando ya está pagado, está listo o ya va en camino. Todo lo demás (sucursal o con saldo sin terminar) -> Apartados.
const abierto = o => ['pendiente', 'listo'].includes(o.status);
const enEnvios = o => abierto(o) && o.kind === 'envio' && (saldoDe(o) <= 0.001 || o.status === 'listo' || o.delivery === 'en_camino');
const enApartados = o => abierto(o) && !enEnvios(o);
const envios = () => listaPedidos('Envíos a domicilio', 'No hay envíos por atender.', enEnvios, true);
function apartados() {
  return lazy(async box => {
    const [cat, r] = await Promise.all([getCat(), sb.from('orders').select(ORD).in('status', ['pendiente', 'listo']).order('delivery_date', { ascending: true, nullsFirst: false }).order('created_at').limit(300)]);
    if (r.error) throw r.error;
    const A = st.af || (st.af = { q: '', pago: '', est: '', ent: '', fecha: '' }), base = r.data.filter(enApartados), hoy = hoyStr();
    const qin = h('input', 'form-control'); qin.placeholder = 'Buscar por # de pedido, cliente o celular…'; qin.maxLength = 60; qin.value = A.q;
    const lista = h('div'), cnt = h('p', 'small text-secondary');
    const sel = (opts, key) => { const s = h('select', 'form-select form-select-sm w-auto'); opts.forEach(([v, l]) => s.append(Object.assign(h('option', null, l), { value: v }))); s.value = A[key]; s.onchange = () => { A[key] = s.value; if (key === 'ent') { A.fecha = ''; fd.value = ''; } pinta(); }; return s; };
    const fd = h('input', 'form-control form-control-sm w-auto'); fd.type = 'date'; fd.value = A.fecha; fd.title = 'Fecha de entrega exacta'; fd.onchange = () => { A.fecha = fd.value; if (A.fecha) { A.ent = ''; render(); return; } pinta(); };
    const limpiar = h('button', 'btn btn-sm btn-outline-secondary', null, [ic('x-lg'), 'Limpiar']); limpiar.onclick = () => { st.af = null; render(); };
    const filtros = h('div', 'd-flex flex-wrap gap-2 align-items-center mb-3', null, [
      sel([['', 'Pago: todos'], ['cobrar', 'Sin pago (X COBRAR)'], ['abonado', 'Abonado'], ['pagado', 'Pagado']], 'pago'), sel([['', 'Estado: todos'], ['pendiente', 'Pendiente'], ['listo', 'Listo']], 'est'),
      sel([['', 'Entrega: cualquier fecha'], ['hoy', 'Hoy'], ['vencidos', 'Vencidos'], ['semana', 'Próximos 7 días'], ['sin', 'Sin fecha']], 'ent'), fd, limpiar]);
    const pinta = () => {
      A.q = qin.value; const t = A.q.trim().toLowerCase().replace(/^#/, '');
      const data = base.filter(o => {
        const pg = sum(o.payments), cu = o.customers || {}, d = o.delivery_date;
        if (t && !(String(o.id) === t || String(cu.name || '').toLowerCase().includes(t) || String(cu.phone || '').includes(t))) return false;
        if (A.pago === 'cobrar' && pg > 0) return false; if (A.pago === 'abonado' && !(pg > 0 && saldoDe(o) > 0.001)) return false; if (A.pago === 'pagado' && saldoDe(o) > 0.001) return false;
        if (A.est && o.status !== A.est) return false;
        if (A.ent === 'hoy' && d !== hoy) return false; if (A.ent === 'vencidos' && !(d && d < hoy)) return false;
        if (A.ent === 'semana' && !(d && d >= hoy && d <= addDias(hoy, 7))) return false; if (A.ent === 'sin' && d) return false;
        if (A.fecha && d !== A.fecha) return false;
        return true;
      });
      lista.replaceChildren(); cnt.textContent = `${data.length} de ${base.length} apartados`;
      if (!data.length) lista.append(h('p', 'text-secondary', base.length ? 'No hay apartados con esos filtros.' : 'No hay apartados pendientes.'));
      data.forEach(o => lista.append(pedidoCard(o, cat)));
    };
    qin.oninput = pinta; pinta();
    box.replaceChildren(h('h5', null, 'Apartados'), qin, h('div', 'my-2'), filtros, cnt, lista);
  });
}

/* ---------- Calendario de entregas (Ventas) ---------- */
const addDias = (s, k) => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() + k); return ymd(d); };
const lunesDe = s => { const d = new Date(s + 'T12:00:00'); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return ymd(d); };
const fechaLarga = s => new Date(s + 'T12:00:00').toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
const fechaCorta = s => new Date(s + 'T12:00:00').toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' });
const ventas = () => {
  const w = h('div'), v = st.vv || 'lista';
  w.append(h('div', 'd-flex flex-wrap gap-2 mb-3', null, [['lista', 'receipt', 'Ventas'], ['cal', 'calendar3', 'Calendario de entregas']].map(([k, i, l]) => {
    const b = h('button', 'chip' + (v === k ? ' on' : ''), null, [ic(i), l]); b.onclick = () => { st.vv = k; render(); }; return b; })), v === 'cal' ? calendario() : ventasLista());
  return w;
};
function calendario() {
  return lazy(async box => {
    const K = st.cal || (st.cal = { vista: 'mes', fecha: hoyStr(), sel: hoyStr() }), hoy = hoyStr(), pend = ['pendiente', 'listo'], cook = st.me.cargo === 'cocinero';
    let a, b;
    if (K.vista === 'dia') a = b = K.fecha; else if (K.vista === 'semana') { a = lunesDe(K.fecha); b = addDias(a, 6); }
    else if (K.vista === 'mes') { a = lunesDe(K.fecha.slice(0, 8) + '01'); b = addDias(a, 41); } else { a = hoy; b = addDias(hoy, 30); }
    const [cat, r, v] = await Promise.all([getCat(),
      sb.from('orders').select(ORD + ',order_tamales(salsa_id,qty)').in('status', pend).gte('delivery_date', a).lte('delivery_date', b).order('delivery_date').limit(1000),
      sb.from('orders').select('id', { count: 'exact', head: true }).in('status', pend).lt('delivery_date', hoy)]);
    if (r.error) throw r.error;
    const por = new Map(); r.data.forEach(o => { if (!por.has(o.delivery_date)) por.set(o.delivery_date, []); por.get(o.delivery_date).push(o); });
    const tam = os => os.reduce((s, o) => s + (o.order_tamales || []).reduce((x, t) => x + t.qty, 0), 0);
    const mover = k => { if (K.vista === 'mes') { const d = new Date(K.fecha.slice(0, 8) + '01T12:00:00'); d.setMonth(d.getMonth() + k); K.fecha = ymd(d); } else K.fecha = addDias(K.fecha, K.vista === 'semana' ? 7 * k : k); K.sel = K.fecha; render(); };
    const titulo = K.vista === 'mes' ? new Date(K.fecha.slice(0, 8) + '01T12:00:00').toLocaleDateString('es-MX', { month: 'long', year: 'numeric' })
      : K.vista === 'semana' ? `${fechaCorta(a)} al ${fechaCorta(b)}` : K.vista === 'dia' ? fechaLarga(K.fecha) : 'Próximos 30 días';
    const nav = h('div', 'd-flex flex-wrap gap-2 align-items-center mb-3');
    [['dia', 'Día'], ['semana', 'Semana'], ['mes', 'Mes'], ['agenda', 'Agenda']].forEach(([k, l]) => { const c = h('button', 'chip' + (K.vista === k ? ' on' : ''), l); c.onclick = () => { K.vista = k; render(); }; nav.append(c); });
    if (K.vista !== 'agenda') {
      const p = h('button', 'btn btn-sm btn-outline-secondary', null, [h('i', 'bi bi-chevron-left')]), s = h('button', 'btn btn-sm btn-outline-secondary', null, [h('i', 'bi bi-chevron-right')]), t = h('button', 'btn btn-sm btn-outline-secondary', 'Hoy');
      p.onclick = () => mover(-1); s.onclick = () => mover(1); t.onclick = () => { K.fecha = K.sel = hoy; render(); }; nav.append(p, t, s);
    }
    const resumen = h('div', 'card p-3 mb-3 d-flex flex-row flex-wrap align-items-center gap-3', null, [h('strong', 'text-capitalize flex-grow-1', titulo),
      h('span', 'acc fw-semibold', `${r.data.length} pedidos · ${tam(r.data).toLocaleString('es-MX')} tamales por entregar`), ...(v.count ? [badge(`${v.count} vencidos`, 'danger')] : [])]);
    const diaCard = (f, os) => {
      const c = h('div', 'card p-3 mb-3' + (f === hoy ? ' border-2' : '')), sab = new Map();
      os.forEach(o => (o.order_tamales || []).forEach(t => sab.set(t.salsa_id, (sab.get(t.salsa_id) || 0) + t.qty)));
      c.append(h('div', 'd-flex justify-content-between flex-wrap gap-2', null, [h('strong', 'text-capitalize', fechaLarga(f) + (f === hoy ? ' (hoy)' : '')), h('span', f < hoy ? 'text-danger fw-semibold' : 'acc fw-semibold', `${os.length} pedidos · ${tam(os).toLocaleString('es-MX')} tamales`)]));
      if (sab.size) c.append(h('div', 'small text-secondary mb-1', [...sab].map(([id, q]) => `${salsaName(id)}: ${q}`).join(' · ')));
      if (!os.length) c.append(h('div', 'small text-secondary', 'Sin entregas programadas.'));
      os.forEach(o => {
        if (cook) {   // el cocinero solo ve qué hay que preparar: sin dinero ni botones
          c.append(h('div', 'mt-2 pt-2 border-top', null, [h('div', 'd-flex justify-content-between gap-2', null, [h('strong', null, `#${o.id} · ${o.customers ? o.customers.name : 'Cliente'}`), h('span', null, `${tam([o])} tamales`)]),
            ...lineas(o, cat).map(l => h('div', 'small', l.txt + (l.sub ? ` (${l.sub})` : ''))), h('div', 'mt-1', null, [badge(o.status === 'listo' ? 'Listo' : 'Por preparar', o.status === 'listo' ? 'info' : 'warning')])])); return;
        }
        const [lab, col] = etiqueta(o), bt = h('button', 'btn btn-sm btn-outline-secondary w-100 text-start mt-2', null, [
          h('div', 'd-flex justify-content-between gap-2', null, [h('strong', null, `#${o.id} · ${o.customers ? o.customers.name : 'Mostrador'}`), h('span', null, `${tam([o])} tamales`)]),
          h('div', 'mt-1', null, [badge(lab, col), ...(o.status === 'listo' ? [badge('Listo', 'info')] : []), ...(o.assigned_to ? [badge('Reparte: ' + staffName(o.assigned_to), 'dark')] : [])])]);
        bt.onclick = () => verDetalle(o, cat); c.append(bt);
      });
      return c;
    };
    box.replaceChildren(nav, resumen);
    if (K.vista === 'dia') box.append(diaCard(K.fecha, por.get(K.fecha) || []));
    else if (K.vista === 'semana') for (let i = 0; i < 7; i++) { const f = addDias(a, i); box.append(diaCard(f, por.get(f) || [])); }
    else if (K.vista === 'agenda') { const fs = [...por.keys()].sort(); if (!fs.length) box.append(h('p', 'text-secondary', 'No hay entregas programadas en los próximos 30 días.')); fs.forEach(f => box.append(diaCard(f, por.get(f)))); }
    else {
      const g = h('div', 'cal mb-3'); ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'].forEach(d => g.append(h('div', 'cal-h', d)));
      for (let i = 0; i < 42; i++) {
        const f = addDias(a, i), os = por.get(f) || [], otro = f.slice(0, 7) !== K.fecha.slice(0, 7), t = tam(os);
        const c = h('button', 'cal-d' + (otro ? ' otro' : '') + (f === hoy ? ' hoy' : '') + (f === K.sel ? ' sel' : '') + (os.length && f < hoy ? ' venc' : ''), null,
          [h('div', 'cal-n', String(Number(f.slice(8)))), ...(os.length ? [h('div', 'cal-t', t.toLocaleString('es-MX')), h('div', 'cal-p', os.length + (os.length === 1 ? ' ped.' : ' peds.'))] : [])]);
        c.onclick = () => { K.sel = f; render(); }; g.append(c);
      }
      box.append(g, diaCard(K.sel, por.get(K.sel) || []));
    }
  });
}

/* ---------- MATRIZ: bitácora de auditoría (solo master y administrador) ---------- */
const ENTIDADES = ['sesión', 'venta', 'pago', 'cliente', 'producto', 'olla', 'categoría', 'corte', 'usuario', 'matriz', 'almacenamiento', 'exportación'];
const ACCIONES = ['login', 'logout', 'cambio_clave', 'crear', 'editar', 'eliminar', 'exportar', 'solicitar_clave', 'atender_clave', 'restablecer_clave', 'deshabilitar', 'habilitar'];
const ACOL = { crear: 'success', editar: 'info', eliminar: 'danger', login: 'secondary', logout: 'secondary', exportar: 'primary' };
function matriz() {
  return lazy(async box => {
    const M = st.mf || (st.mf = { desde: hoyStr(), hasta: hoyStr(), user: '', ent: '', act: '', q: '', n: 200, all: false });
    const consulta = (sel, opts) => {
      let q = sb.from('audit_log').select(sel, opts);
      if (!M.all) { const [a, b] = rango(M.desde, M.hasta); q = q.gte('at', a).lt('at', b); }
      if (M.user) q = q.eq('user_id', M.user); if (M.ent) q = q.eq('entity', M.ent); if (M.act) q = q.eq('action', M.act);
      if (M.q.trim()) q = q.ilike('detail', '%' + M.q.trim().replace(/[%_,()\\]/g, ' ') + '%');
      return q;
    };
    const r = await consulta('*', { count: 'exact' }).order('at', { ascending: false }).order('id', { ascending: false }).limit(M.n); errDb(r.error);
    const sel = (opts, val, fn) => { const s = h('select', 'form-select form-select-sm w-auto'); opts.forEach(([v, l]) => s.append(Object.assign(h('option', null, l), { value: v }))); s.value = val; s.onchange = () => { fn(s.value); M.n = 200; render(); }; return s; };
    const fechas = filtroFechas(M), allc = h('button', 'chip' + (M.all ? ' on' : ''), 'Todas las fechas'); allc.onclick = () => { M.all = !M.all; render(); }; fechas.append(allc);
    const q = h('input', 'form-control form-control-sm w-auto'); q.placeholder = 'Buscar en el detalle…'; q.value = M.q; q.maxLength = 60; q.onkeydown = e => { if (e.key === 'Enter') { M.q = q.value; M.n = 200; render(); } };
    const filtros = h('div', 'd-flex flex-wrap gap-2 align-items-center mb-3', null, [
      sel([['', 'Usuario: todos'], ...staffArr().map(x => [x.id, x.full_name])], M.user, v => { M.user = v; }),
      sel([['', 'Módulo: todos'], ...ENTIDADES.map(x => [x, x])], M.ent, v => { M.ent = v; }), sel([['', 'Acción: todas'], ...ACCIONES.map(x => [x, x])], M.act, v => { M.act = v; }), q]);
    const FILAS = d => [['Fecha', 'Usuario', 'Acción', 'Módulo', 'Detalle']].concat(d.map(x => [new Date(x.at).toLocaleString('es-MX'), safe(x.user_name || '—'), x.action, x.entity, safe(x.detail || '')]));
    const ex = h('button', 'btn btn-outline-success', null, [ic('file-earmark-excel'), 'Exportar a Excel']);
    ex.onclick = () => seguro(async () => {
      if (r.count > 20000) return toast('Son más de 20,000 registros: acota las fechas o filtros.', false);
      if (!await confirmar(`¿Descargar ${r.count} registros de la Matriz en Excel?`)) return;
      const d = await traer(() => consulta('*').order('at', { ascending: false }).order('id', { ascending: false })); xlsx('matriz', 'Matriz', FILAS(d)); logEv('exportar', `Matriz: ${d.length} registros`);
    });
    const tbl = h('table', 'table table-sm align-middle'); tbl.append(h('thead', null, null, [h('tr', null, null, ['Fecha', 'Usuario', 'Acción', 'Módulo', 'Detalle'].map(x => h('th', null, x)))]));
    const tb = h('tbody'); r.data.forEach(x => tb.append(h('tr', null, null, [h('td', 'text-nowrap small', new Date(x.at).toLocaleString('es-MX')), h('td', null, x.user_name || '—'), h('td', null, null, [badge(x.action, ACOL[x.action] || 'secondary')]), h('td', null, x.entity), h('td', 'small', x.detail || '')])));
    tbl.append(tb);
    const vac = h('div', 'card p-3 mt-4'), ds = h('select', 'form-select w-auto');
    [['30', 'anteriores a 30 días'], ['90', 'anteriores a 90 días'], ['180', 'anteriores a 180 días'], ['365', 'anteriores a 1 año'], ['todos', 'TODOS los registros']].forEach(([v, l]) => ds.append(Object.assign(h('option', null, l), { value: v })));
    const vb = h('button', 'btn btn-outline-danger', null, [ic('file-earmark-excel'), 'Exportar y vaciar']);
    vb.onclick = () => seguro(async () => {
      const antes = ds.value === 'todos' ? null : new Date(Date.now() - Number(ds.value) * 86400000).toISOString(), mk = () => { let z = sb.from('audit_log').select('*'); return antes ? z.lt('at', antes) : z; };
      let cq = sb.from('audit_log').select('id', { count: 'exact', head: true }); if (antes) cq = cq.lt('at', antes); const c = await cq; errDb(c.error);
      if (!c.count) return toast('No hay registros que vaciar con ese criterio.', false);
      if (c.count > 20000) return toast('Son más de 20,000: elige un periodo más corto para exportarlos antes de borrar.', false);
      if (!await confirmar(`Se van a BORRAR ${c.count} registros de la Matriz. Antes se descargará un Excel con esa información. ¿Continuar?`)) return;
      const d = await traer(() => mk().order('at', { ascending: false }).order('id', { ascending: false }));
      if (d.length < c.count) return toast('No se pudo exportar todo, así que no se borró nada.', false);
      xlsx('matriz_respaldo', 'Matriz', FILAS(d)); logEv('exportar', `Respaldo antes de vaciar la Matriz: ${d.length} registros`);
      if (!await confirmar('El Excel ya se descargó. Revisa que abra bien. ¿Vaciar la Matriz ahora? No se puede deshacer.')) return;
      const nn = await rpc('purge_audit', { p_before: antes }); toast(`${nn} registros eliminados`); render();
    });
    vac.append(h('h6', null, 'Vaciar la Matriz'), h('p', 'small text-secondary', 'Sirve para que la base de datos no se llene. Siempre se descarga primero un Excel y queda un registro de que se vació.'), h('div', 'd-flex flex-wrap gap-2', null, [ds, vb]));
    box.replaceChildren(h('h5', null, 'Matriz de movimientos'), fechas, filtros,
      h('div', 'd-flex flex-wrap align-items-center gap-2 mb-2', null, [h('span', 'small text-secondary flex-grow-1', `Mostrando ${r.data.length} de ${r.count}`), ex]),
      r.data.length ? h('div', 'table-responsive', null, [tbl]) : h('p', 'text-secondary', 'No hay movimientos con estos filtros.'));
    if (r.count > r.data.length) { const m = h('button', 'btn btn-outline-secondary w-100', 'Cargar más'); m.onclick = () => { M.n += 200; render(); }; box.append(m); }
    box.append(vac);
  });
}

/* ---------- Buscador de pedidos (Caja) ---------- */
async function buscarPedidos(q) {
  q = (q || '').trim(); if (!q) return [];
  const num = q.replace(/^#/, ''), out = [];
  if (/^\d{1,9}$/.test(num)) { const r = await sb.from('orders').select(ORD).eq('id', Number(num)); errDb(r.error); out.push(...r.data); }
  const t = q.replace(/[%_,()\\*"']/g, ' ').trim();
  if (t.length >= 2) {
    const cs = await sb.from('customers').select('id').or(`name.ilike.%${t}%,phone.ilike.%${t}%`).limit(30); errDb(cs.error);
    if (cs.data.length) { const r2 = await sb.from('orders').select(ORD).in('customer_id', cs.data.map(c => c.id)).order('created_at', { ascending: false }).limit(40); errDb(r2.error); out.push(...r2.data); }
  }
  const vistos = new Set(); return out.filter(o => !vistos.has(o.id) && vistos.add(o.id));
}
