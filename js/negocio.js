'use strict';
/* Módulos de negocio. Se carga antes de app.js; usa sus helpers (h, ic, st, sb, toast, confirmar, seguro, render) al ejecutarse. */

const $$ = n => Number(n || 0).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
const fdt = d => new Date(d).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const sum = a => (a || []).reduce((x, y) => x + Number(y.amount), 0);
const ST = { pendiente: 'Pendiente', listo: 'Listo', entregado: 'Entregado', cancelado: 'Cancelado' };
const DL = { por_enviar: 'Por enviar', en_camino: 'En camino', entregado: 'Entregado' };
const COL = { pendiente: 'warning', listo: 'info', entregado: 'success', cancelado: 'secondary' };
const safe = s => /^[=+\-@]/.test(String(s)) ? "'" + s : String(s);
const badge = (t, c) => h('span', 'badge bg-' + c + ' me-1', t);
const newCart = () => ({ items: {}, kind: 'mostrador', customer: '', note: '', paid: '', method: 'efectivo' });
const METODOS = [['efectivo', 'Efectivo'], ['transferencia', 'Transferencia'], ['tarjeta', 'Tarjeta']];

/* ---------- Utilidades ---------- */
async function rpc(name, args) {
  const { data, error } = await sb.rpc(name, args);
  if (error) {
    const e = new Error(error.message);
    if (error.code === 'P0001') e.msg = error.message; else console.error(error);
    throw e;
  }
  return data;
}
function lazy(fn) {
  const box = h('div');
  box.append(h('p', 'text-secondary', null, [ic('hourglass-split'), 'Cargando…']));
  fn(box).catch(e => { console.error(e); box.replaceChildren(h('p', 'text-danger', 'No se pudo cargar. Revisa tu conexión.')); });
  return box;
}
function pwField(ph, ac) {
  const i = h('input', 'form-control'); i.type = 'password'; i.placeholder = ph; i.autocomplete = ac; i.maxLength = 72;
  const ey = h('i', 'bi bi-eye');
  const b = h('button', 'btn btn-outline-secondary', null, [ey]); b.type = 'button'; b.title = 'Mostrar u ocultar contraseña';
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
      inputs[f.key] = i; body.append(h('label', 'small text-secondary', f.label), i);
    });
    const yes = h('button', 'btn btn-acc px-4', ok); yes.onclick = () => { const o = {}; for (const k in inputs) o[k] = inputs[k].value; done(o); };
    const no = h('button', 'btn btn-outline-secondary px-4', 'Cancelar'); no.onclick = () => done(null);
    ov.append(h('div', 'box', null, [h('h5', 'mb-3', title), body, h('div', 'd-flex gap-2 justify-content-center mt-2', null, [no, yes])]));
    document.body.append(ov);
  });
}
async function abonar(o, saldo) {
  const r = await formModal(`Abono · pedido #${o.id}`, [
    { key: 'a', label: 'Monto (saldo ' + $$(saldo) + ')', type: 'number', min: 0.01, step: '0.01', mode: 'decimal' },
    { key: 'm', label: 'Método de pago', options: METODOS }], 'Abonar');
  if (!r) return;
  const a = Math.round(Number(r.a) * 100) / 100;
  if (!Number.isFinite(a) || a <= 0 || a > saldo + 0.001) return toast('Monto inválido. Máximo ' + $$(saldo), false);
  if (!await confirmar(`¿Registrar abono de ${$$(a)}?`)) return;
  await rpc('add_payment', { p_order: o.id, p_amount: a, p_method: r.m });
  toast('Abono registrado'); render();
}
function pedidoCard(o, extra) {
  const pagado = sum(o.payments), saldo = Number(o.total) - pagado;
  const c = h('div', 'card p-3 mb-2');
  c.append(h('div', 'd-flex justify-content-between', null, [h('strong', null, `#${o.id} · ${o.customers ? o.customers.name : 'Mostrador'}`), h('span', null, $$(o.total))]));
  c.append(h('div', 'small my-1', null, [badge(ST[o.status], COL[o.status]), ...(o.delivery ? [badge(DL[o.delivery], 'primary')] : []),
    `Pagado ${$$(pagado)} · Saldo ${$$(saldo)}`]));
  const row = h('div', 'd-flex flex-wrap gap-2 mt-2');
  if (saldo > 0.001 && o.status !== 'cancelado') {
    const b = h('button', 'btn btn-sm btn-acc', null, [ic('cash-coin'), 'Abonar']); b.onclick = () => seguro(() => abonar(o, saldo)); row.append(b);
  }
  if (extra) extra(c, row, o, saldo);
  c.append(row); return c;
}

/* ---------- Caja ---------- */
function caja() {
  return lazy(async box => {
    const [pr, cu, od, lc] = await Promise.all([
      sb.from('products').select('*').eq('active', true).order('name'),
      sb.from('customers').select('id,name').order('name').limit(500),
      sb.from('orders').select('id,total,status,kind,delivery,created_at,customers(name),payments(amount)').neq('status', 'cancelado').order('created_at', { ascending: false }).limit(150),
      sb.from('cash_closures').select('*').order('to_ts', { ascending: false }).limit(5)]);
    for (const r of [pr, cu, od, lc]) if (r.error) throw r.error;
    const from = lc.data[0] ? lc.data[0].to_ts : '2000-01-01T00:00:00Z';
    const py = await sb.from('payments').select('amount,method,orders(status)').gt('created_at', from).limit(2000);
    if (py.error) throw py.error;
    const C = st.cart || (st.cart = newCart());

    const draw = () => {
      const items = pr.data.filter(p => C.items[p.id]);
      const total = items.reduce((a, p) => a + Number(p.price) * C.items[p.id], 0);
      const left = h('div', 'col-md-6'), right = h('div', 'col-md-6');
      left.append(h('h5', null, 'Productos'));
      if (!pr.data.length) left.append(h('p', 'text-secondary', 'Aún no hay productos. Agrégalos en Catálogo.'));
      const grid = h('div', 'd-grid gap-2');
      pr.data.forEach(p => {
        const b = h('button', 'btn btn-outline-secondary text-start', null, [h('div', 'fw-bold', p.name), h('small', null, $$(p.price))]);
        b.onclick = () => { C.items[p.id] = Math.min(1000, (C.items[p.id] || 0) + 1); draw(); }; grid.append(b);
      });
      left.append(grid);

      const cart = h('div', 'card p-3'); cart.append(h('h5', null, 'Pedido'));
      if (!items.length) cart.append(h('p', 'text-secondary', 'Toca un producto para agregarlo.'));
      items.forEach(p => {
        const q = C.items[p.id];
        const mk = (icon, fn) => { const b = h('button', 'btn btn-sm btn-outline-secondary', null, [h('i', 'bi bi-' + icon)]); b.onclick = fn; return b; };
        cart.append(h('div', 'd-flex align-items-center gap-2 mb-2', null, [
          h('span', 'flex-grow-1', `${p.name} · ${$$(Number(p.price) * q)}`),
          mk('dash-lg', () => { if (q <= 1) delete C.items[p.id]; else C.items[p.id] = q - 1; draw(); }),
          h('strong', null, String(q)),
          mk('plus-lg', () => { C.items[p.id] = Math.min(1000, q + 1); draw(); }),
          mk('x-lg', () => { delete C.items[p.id]; draw(); })]));
      });
      const kinds = h('div', 'd-flex gap-2 my-2', null, [['mostrador', 'shop', 'Mostrador'], ['envio', 'truck', 'Envío']].map(([k, i, l]) => {
        const b = h('button', 'chip' + (C.kind === k ? ' on' : ''), null, [ic(i), l]); b.onclick = () => { C.kind = k; draw(); }; return b; }));
      const cs = h('select', 'form-select mb-2'); cs.append(Object.assign(h('option', null, C.kind === 'envio' ? '— Elige cliente (obligatorio) —' : '— Sin cliente —'), { value: '' }));
      cu.data.forEach(c => cs.append(Object.assign(h('option', null, c.name), { value: String(c.id) }))); cs.value = C.customer; cs.onchange = () => { C.customer = cs.value; };
      const note = h('input', 'form-control mb-2'); note.placeholder = 'Nota (opcional)'; note.maxLength = 200; note.value = C.note; note.oninput = () => { C.note = note.value; };
      const paid = h('input', 'form-control'); paid.type = 'number'; paid.min = 0; paid.step = '0.01'; paid.inputMode = 'decimal'; paid.placeholder = 'Abono / pago ahora'; paid.value = C.paid; paid.oninput = () => { C.paid = paid.value; };
      const met = h('select', 'form-select w-auto'); METODOS.forEach(([v, l]) => met.append(Object.assign(h('option', null, l), { value: v }))); met.value = C.method; met.onchange = () => { C.method = met.value; };
      const go = h('button', 'btn btn-acc btn-lg w-100 mt-3', null, [ic('check2-circle'), 'Guardar pedido · ' + $$(total)]);
      go.onclick = () => seguro(async () => {
        if (!items.length) return toast('Agrega al menos un producto.', false);
        if (C.kind === 'envio' && !C.customer) return toast('Un envío necesita cliente.', false);
        const pd = C.paid === '' ? 0 : Math.round(Number(C.paid) * 100) / 100;
        if (!Number.isFinite(pd) || pd < 0 || pd > total + 0.001) return toast('El pago no puede ser mayor al total.', false);
        if (!await confirmar(`¿Guardar pedido por ${$$(total)}${pd ? ' con pago de ' + $$(pd) : ''}?`)) return;
        await rpc('create_order', { p_customer: C.customer ? Number(C.customer) : null, p_kind: C.kind, p_note: C.note || null,
          p_items: items.map(p => ({ product_id: p.id, qty: C.items[p.id] })), p_paid: pd, p_method: C.method });
        st.cart = newCart(); toast('Pedido guardado'); render();
      });
      cart.append(kinds, cs, note, h('div', 'd-flex gap-2', null, [paid, met]), go); right.append(cart);

      // Pendientes de cobro
      const pend = od.data.filter(o => Number(o.total) - sum(o.payments) > 0.001);
      const pe = h('div', 'mt-4'); pe.append(h('h5', null, 'Pedidos con saldo por cobrar'));
      if (!pend.length) pe.append(h('p', 'text-secondary', 'No hay saldos pendientes.'));
      pend.slice(0, 30).forEach(o => pe.append(pedidoCard(o)));

      // Corte
      const pays = py.data.filter(p => !p.orders || p.orders.status !== 'cancelado');
      const por = m => pays.filter(p => p.method === m).reduce((a, p) => a + Number(p.amount), 0);
      const ct = h('div', 'card p-3 mt-4'); ct.append(h('h5', null, null, [ic('scissors'), 'Corte de caja']));
      ct.append(h('p', 'mb-2', `Desde el último corte: Efectivo ${$$(por('efectivo'))} · Transferencia ${$$(por('transferencia'))} · Tarjeta ${$$(por('tarjeta'))} · Total ${$$(por('efectivo') + por('transferencia') + por('tarjeta'))}`));
      const cb = h('button', 'btn btn-outline-secondary', null, [ic('scissors'), 'Hacer corte ahora']);
      cb.onclick = () => seguro(async () => { if (!await confirmar('¿Hacer el corte de caja con estos totales?')) return; await rpc('close_cash'); toast('Corte guardado'); render(); });
      ct.append(cb);
      lc.data.forEach(k => {
        const row = h('div', 'small d-flex align-items-center gap-2 mt-2', null, [h('span', 'flex-grow-1', `${fdt(k.to_ts)} · Efvo ${$$(k.efectivo)} · Transf ${$$(k.transferencia)} · Tarj ${$$(k.tarjeta)}`)]);
        if (isAdmin()) { const d = h('button', 'btn btn-sm btn-outline-danger', null, [ic('trash')]); d.title = 'Eliminar corte';
          d.onclick = () => seguro(async () => { if (!await confirmar('¿Eliminar este corte? No se puede deshacer.')) return; const { error } = await sb.from('cash_closures').delete().eq('id', k.id); if (error) throw error; toast('Corte eliminado'); render(); });
          row.append(d); }
        ct.append(row);
      });
      box.replaceChildren(h('div', 'row g-3', null, [left, right]), pe, ct);
    };
    draw();
  });
}

/* ---------- Envíos ---------- */
function envios() {
  return lazy(async box => {
    const r = await sb.from('orders').select('id,total,status,kind,delivery,note,created_at,customers(name,phone,address),payments(amount)')
      .eq('kind', 'envio').neq('status', 'cancelado').neq('delivery', 'entregado').order('created_at');
    if (r.error) throw r.error;
    box.replaceChildren(h('h5', null, 'Envíos pendientes'));
    if (!r.data.length) box.append(h('p', 'text-secondary', 'No hay envíos pendientes.'));
    const avanzar = (o, status, delivery, msg, saldo) => seguro(async () => {
      if (!await confirmar(msg + (delivery === 'entregado' && saldo > 0.001 ? ` Ojo: aún debe ${$$(saldo)}.` : ''))) return;
      await rpc('set_order_status', { p_order: o.id, p_status: status, p_delivery: delivery }); toast('Actualizado'); render();
    });
    r.data.forEach(o => box.append(pedidoCard(o, (c, row, o2, saldo) => {
      const cu = o2.customers || {};
      c.append(h('div', 'small text-secondary', null, [ic('geo-alt'), (cu.address || 'Sin dirección') + ' · ', ic('telephone'), cu.phone || 'Sin teléfono']));
      if (o2.note) c.append(h('div', 'small fst-italic', 'Nota: ' + o2.note));
      const mk = (txt, icon, fn) => { const b = h('button', 'btn btn-sm btn-outline-secondary', null, [ic(icon), txt]); b.onclick = fn; row.append(b); };
      if (o2.status === 'pendiente') mk('Marcar listo', 'check2', () => avanzar(o2, 'listo', null, `¿El pedido #${o2.id} está listo?`, saldo));
      if (o2.delivery === 'por_enviar') mk('Salió a reparto', 'truck', () => avanzar(o2, o2.status === 'pendiente' ? 'listo' : o2.status, 'en_camino', `¿El pedido #${o2.id} salió a reparto?`, saldo));
      if (o2.delivery === 'en_camino') mk('Entregado', 'box-seam', () => avanzar(o2, 'entregado', 'entregado', `¿Confirmas que el pedido #${o2.id} fue entregado?`, saldo));
    })));
  });
}

/* ---------- Clientes ---------- */
function clientes() {
  return lazy(async box => {
    const r = await sb.from('customers').select('*').order('name').limit(500); if (r.error) throw r.error;
    const add = h('button', 'btn btn-acc mb-3', null, [ic('person-plus'), 'Nuevo cliente']);
    add.onclick = () => seguro(async () => {
      const f = await formModal('Nuevo cliente', [{ key: 'n', label: 'Nombre', max: 80 }, { key: 't', label: 'Teléfono', type: 'tel', mode: 'tel', max: 20 }, { key: 'd', label: 'Dirección de envío', max: 200 }], 'Guardar');
      if (!f) return;
      const n = f.n.trim().replace(/\s+/g, ' '), t = f.t.trim(), d = f.d.trim();
      if (n.length < 2) return toast('Escribe el nombre.', false);
      if (t && !/^[0-9+() -]{7,20}$/.test(t)) return toast('Teléfono inválido.', false);
      if (!await confirmar(`¿Guardar a ${n}?`)) return;
      const { error } = await sb.from('customers').insert({ name: n, phone: t || null, address: d || null }); if (error) throw error;
      toast('Cliente guardado'); render();
    });
    box.replaceChildren(add);
    if (!r.data.length) box.append(h('p', 'text-secondary', 'Todavía no hay clientes.'));
    r.data.forEach(c => {
      const row = h('div', 'card p-2 mb-2 d-flex flex-row align-items-center gap-2', null, [
        h('div', 'flex-grow-1', null, [h('strong', null, c.name), h('div', 'small text-secondary', (c.phone || 'Sin teléfono') + ' · ' + (c.address || 'Sin dirección'))])]);
      if (isAdmin()) { const d = h('button', 'btn btn-sm btn-outline-danger', null, [ic('trash')]); d.title = 'Eliminar cliente';
        d.onclick = () => seguro(async () => { if (!await confirmar(`¿Eliminar a ${c.name}?`)) return; const { error } = await sb.from('customers').delete().eq('id', c.id);
          if (error) return toast('No se puede eliminar: tiene pedidos registrados.', false); toast('Cliente eliminado'); render(); });
        row.append(d); }
      box.append(row);
    });
  });
}

/* ---------- Ventas ---------- */
function verAbonos(o) {
  const ov = h('div', 'ov'), bx = h('div', 'box text-start', null, [h('h5', null, `Abonos · pedido #${o.id}`)]);
  if (!o.payments.length) bx.append(h('p', 'text-secondary', 'Sin abonos.'));
  o.payments.forEach(p => {
    const row = h('div', 'd-flex align-items-center gap-2 mb-2', null, [h('span', 'flex-grow-1', `${fdt(p.created_at)} · ${p.method} · ${$$(p.amount)}`)]);
    if (isAdmin()) { const d = h('button', 'btn btn-sm btn-outline-danger', null, [ic('trash')]); d.title = 'Eliminar abono';
      d.onclick = () => seguro(async () => { if (!await confirmar('¿Eliminar este abono? El saldo del pedido aumentará.')) return;
        const { error } = await sb.from('payments').delete().eq('id', p.id); if (error) throw error; ov.remove(); toast('Abono eliminado'); render(); });
      row.append(d); }
    bx.append(row);
  });
  const x = h('button', 'btn btn-acc w-100 mt-2', 'Cerrar'); x.onclick = () => ov.remove(); bx.append(x); ov.append(bx); document.body.append(ov);
}
function ventas() {
  return lazy(async box => {
    const dias = { hoy: 0, '7': 7, '30': 30 }[st.range] ?? 0, d0 = new Date(); d0.setHours(0, 0, 0, 0); d0.setDate(d0.getDate() - dias);
    const r = await sb.from('orders').select('id,total,status,kind,delivery,created_at,customers(name),payments(id,amount,method,created_at)')
      .gte('created_at', d0.toISOString()).order('created_at', { ascending: false }).limit(1000);
    if (r.error) throw r.error;
    const ok = r.data.filter(o => o.status !== 'cancelado');
    const vendido = ok.reduce((a, o) => a + Number(o.total), 0), cobrado = ok.reduce((a, o) => a + sum(o.payments), 0);
    const chips = h('div', 'd-flex flex-wrap gap-2 mb-3 align-items-center', null, [['hoy', 'Hoy'], ['7', '7 días'], ['30', '30 días']].map(([k, l]) => {
      const b = h('button', 'chip' + (st.range === k ? ' on' : ''), l); b.onclick = () => { st.range = k; render(); }; return b; }));
    const ex = h('button', 'btn btn-outline-success ms-auto', null, [ic('file-earmark-excel'), 'Exportar a Excel']);
    ex.onclick = () => seguro(async () => {
      if (typeof XLSX === 'undefined') return toast('No se cargó la librería de Excel.', false);
      if (!await confirmar('¿Descargar estas ventas en Excel?')) return;
      const rows = [['#', 'Fecha', 'Cliente', 'Tipo', 'Estado', 'Total', 'Pagado', 'Saldo']].concat(r.data.map(o => {
        const pg = sum(o.payments); return [o.id, fdt(o.created_at), safe(o.customers ? o.customers.name : 'Mostrador'), o.kind, ST[o.status], Number(o.total), pg, o.status === 'cancelado' ? 0 : Number(o.total) - pg]; }));
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Ventas');
      XLSX.writeFile(wb, `ventas_${new Date().toISOString().slice(0, 10)}.xlsx`);
    });
    chips.append(ex);
    const sm = h('div', 'card p-3 mb-3 text-center', null, [h('div', 'big', $$(vendido)), h('div', null, `vendido · cobrado ${$$(cobrado)} · por cobrar ${$$(vendido - cobrado)}`)]);
    const tbl = h('table', 'table table-sm align-middle');
    tbl.append(h('thead', null, null, [h('tr', null, null, ['#', 'Fecha', 'Cliente', 'Estado', 'Total', 'Saldo', ''].map(x => h('th', null, x)))]));
    const tb = h('tbody');
    r.data.forEach(o => {
      const pg = sum(o.payments), cancel = o.status === 'cancelado', act = h('td', 'text-nowrap');
      const ab = h('button', 'btn btn-sm btn-outline-secondary me-1', null, [ic('cash')]); ab.title = 'Ver abonos'; ab.onclick = () => verAbonos(o); act.append(ab);
      if (isAdmin()) {
        if (!cancel) { const c = h('button', 'btn btn-sm btn-outline-warning me-1', null, [ic('x-circle')]); c.title = 'Cancelar venta';
          c.onclick = () => seguro(async () => { if (!await confirmar(`¿Cancelar la venta #${o.id}?`)) return; await rpc('cancel_order', { p_order: o.id }); toast('Venta cancelada'); render(); }); act.append(c); }
        const d = h('button', 'btn btn-sm btn-outline-danger', null, [ic('trash')]); d.title = 'Eliminar venta';
        d.onclick = () => seguro(async () => { if (!await confirmar(`¿Eliminar definitivamente la venta #${o.id} y sus abonos?`)) return;
          const { error } = await sb.from('orders').delete().eq('id', o.id); if (error) throw error; toast('Venta eliminada'); render(); }); act.append(d);
      }
      tb.append(h('tr', cancel ? 'text-decoration-line-through opacity-50' : '', null, [h('td', null, String(o.id)), h('td', null, fdt(o.created_at)),
        h('td', null, o.customers ? o.customers.name : 'Mostrador'), h('td', null, null, [badge(ST[o.status], COL[o.status])]),
        h('td', null, $$(o.total)), h('td', null, cancel ? '—' : $$(Number(o.total) - pg)), act]));
    });
    tbl.append(tb);
    box.replaceChildren(chips, sm, r.data.length ? h('div', 'table-responsive', null, [tbl]) : h('p', 'text-secondary', 'No hay ventas en este periodo.'));
  });
}

/* ---------- Catálogo ---------- */
function catalogo() {
  return lazy(async box => {
    const r = await sb.from('products').select('*').order('name'); if (r.error) throw r.error;
    box.id = 'print-area';
    const bar = h('div', 'd-flex flex-wrap gap-2 mb-3 no-print');
    const pdf = h('button', 'btn btn-acc', null, [ic('file-earmark-pdf'), 'Exportar a PDF']);
    pdf.onclick = () => { toast('En la ventana que aparece, elige "Guardar como PDF".'); setTimeout(() => window.print(), 900); };
    bar.append(pdf);
    if (isAdmin()) {
      const add = h('button', 'btn btn-outline-secondary', null, [ic('plus-lg'), 'Agregar sabor']);
      add.onclick = () => seguro(async () => {
        const f = await formModal('Nuevo sabor', [{ key: 'n', label: 'Nombre', max: 60 }, { key: 'd', label: 'Descripción', max: 160 }, { key: 'p', label: 'Precio', type: 'number', min: 0, step: '0.01', mode: 'decimal' }], 'Guardar');
        if (!f) return;
        const n = f.n.trim(), p = Math.round(Number(f.p) * 100) / 100;
        if (n.length < 2) return toast('Escribe el nombre.', false);
        if (!Number.isFinite(p) || p < 0 || p > 100000 || f.p === '') return toast('Precio inválido.', false);
        if (!await confirmar(`¿Agregar "${n}" a ${$$(p)}?`)) return;
        const { error } = await sb.from('products').insert({ name: n, description: f.d.trim() || null, price: p }); if (error) throw error; toast('Agregado'); render();
      });
      bar.append(add);
    }
    const grid = h('div', 'row g-3');
    r.data.filter(p => p.active || isAdmin()).forEach(p => {
      const card = h('div', 'card pcard', null, [h('div', 'pcard-head', null, [h('i', 'bi bi-fire'), p.name]),
        h('div', 'p-3', null, [h('p', 'mb-2', p.description || ''), h('div', 'price', $$(p.price))])]);
      if (!p.active) card.classList.add('no-print', 'opacity-50');
      if (isAdmin()) {
        const ctr = h('div', 'px-3 pb-3 d-flex gap-2 no-print');
        const tg = h('button', 'btn btn-sm btn-outline-secondary', null, [ic(p.active ? 'eye-slash' : 'eye'), p.active ? 'Ocultar' : 'Mostrar']);
        tg.onclick = () => seguro(async () => { if (!await confirmar(`¿${p.active ? 'Ocultar' : 'Mostrar'} "${p.name}"?`)) return; const { error } = await sb.from('products').update({ active: !p.active }).eq('id', p.id); if (error) throw error; render(); });
        const dl = h('button', 'btn btn-sm btn-outline-danger', null, [ic('trash')]);
        dl.onclick = () => seguro(async () => { if (!await confirmar(`¿Eliminar "${p.name}"?`)) return; const { error } = await sb.from('products').delete().eq('id', p.id);
          if (error) return toast('Ya tiene ventas; mejor ocúltalo.', false); toast('Eliminado'); render(); });
        ctr.append(tg, dl); card.append(ctr);
      }
      grid.append(h('div', 'col-12 col-sm-6 col-lg-4', null, [card]));
    });
    box.replaceChildren(h('h4', 'mb-3', null, [ic('stars'), 'Nuestro catálogo de tamales']), bar, r.data.length ? grid : h('p', 'text-secondary', 'Aún no hay sabores en el catálogo.'));
  });
}

/* ---------- Almacenamiento (solo admin) ---------- */
function almacenamiento() {
  return lazy(async box => {
    const u = await rpc('db_usage'), LIM = 500 * 1024 * 1024, pct = Math.min(100, u.bytes / LIM * 100);
    const fmt = b => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB';
    const bar = h('div', 'progress mb-2', null, [h('div', 'progress-bar bg-' + (pct < 60 ? 'success' : pct < 85 ? 'warning' : 'danger'), `${pct.toFixed(1)}%`)]);
    bar.firstChild.style.width = pct + '%';
    const top = h('div', 'card p-3 mb-3', null, [h('h5', null, 'Base de datos'), bar,
      h('p', 'mb-1', `Usado: ${fmt(u.bytes)} de 500 MB (límite del plan gratuito; confírmalo en tu panel de Supabase).`),
      h('small', 'text-secondary', 'Al borrar, el espacio puede tardar un poco en reflejarse.')]);
    const tabs = h('div', 'card p-3 mb-3'); tabs.append(h('h6', null, 'Qué ocupa espacio'));
    Object.entries(u.tables).sort((a, b) => b[1] - a[1]).forEach(([n, b]) => tabs.append(h('div', 'd-flex justify-content-between small', null, [h('span', null, n), h('span', null, fmt(b))])));
    box.replaceChildren(top, tabs);
    const lim = h('div', 'card p-3'); lim.append(h('h6', null, 'Liberar espacio'), h('small', 'text-secondary mb-2 d-block', 'Antes de borrar ventas, expórtalas a Excel desde Ventas.'));
    [['ollas', 'registros de cocina (ollas)'], ['ventas', 'ventas entregadas y pagadas, o canceladas']].forEach(([t, l]) => {
      const sel = h('select', 'form-select w-auto'); [30, 90, 180, 365].forEach(d => sel.append(Object.assign(h('option', null, 'con más de ' + d + ' días'), { value: d })));
      const b = h('button', 'btn btn-outline-danger', null, [ic('trash'), 'Eliminar']);
      b.onclick = () => seguro(async () => {
        if (!await confirmar(`¿Eliminar ${l} ${sel.options[sel.selectedIndex].text}? No se puede deshacer.`)) return;
        const n = await rpc('purge_data', { p_target: t, p_days: Number(sel.value) }); toast(`${n} registros eliminados`); render();
      });
      lim.append(h('div', 'd-flex flex-wrap align-items-center gap-2 mb-2', null, [h('span', 'flex-grow-1', l), sel, b]));
    });
    box.append(lim);
  });
}
