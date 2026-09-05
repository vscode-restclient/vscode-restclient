// Servidor de pruebas compartido por la suite de integración y la del runner.
//
// Responde lo justo para poder afirmar qué llegó: un eco por defecto, códigos
// de estado a demanda, JSON, XML, texto, redirección, lentitud, un stream SSE
// y un WebSocket de eco escrito a mano (RFC 6455, tramas de texto), para no
// meter una dependencia solo para probar.
//
//   node servidor-pruebas.cjs [host]   -> imprime {"puerto": N}
const http = require('http');
const crypto = require('crypto');

const host = process.argv[2] || '127.0.0.1';

const json = (r, codigo, cuerpo, extra = {}) => {
  r.writeHead(codigo, { 'content-type': 'application/json', ...extra });
  r.end(JSON.stringify(cuerpo, null, 1));
};

const s = http.createServer((q, r) => {
  let b = '';
  q.on('data', c => b += c);
  q.on('end', () => {
    const u = q.url;
    const eco = () => ({ metodo: q.method, ruta: u, cabecera: q.headers['x-prueba'] || null, agente: q.headers['user-agent'] || null, recibido: b });
    if (u.startsWith('/estado/')) { const c = Number(u.split('/')[2]) || 500; return json(r, c, { error: 'vaya', estado: c }, { 'x-ruta': u }); }
    if (u === '/redirige') { r.writeHead(302, { location: '/destino' }); return r.end(); }
    if (u === '/lento') { return setTimeout(() => json(r, 200, eco(), { 'x-ruta': u }), 1500); }
    if (u === '/lista') { return json(r, 200, { items: [{ id: 7 }, { id: 9 }] }, { 'x-ruta': u }); }
    if (u === '/json') { return json(r, 200, { anidado: { a: 1, b: [1, 2, 3] } }, { 'x-ruta': u }); }
    if (u === '/texto') { r.writeHead(200, { 'content-type': 'text/plain', 'x-ruta': u }); return r.end('soy texto plano'); }
    if (u === '/xml') { r.writeHead(200, { 'content-type': 'application/xml', 'x-ruta': u }); return r.end('<raiz><hijo>valor</hijo></raiz>'); }
    if (u === '/auth') { return json(r, 200, { token: 'tok-123' }); }
    if (u.startsWith('/eco')) { return json(r, 200, { ruta: u, cabecera: q.headers['x-prueba'] || null, autorizacion: q.headers.authorization || null, recibido: b }); }
    if (u.startsWith('/facturas')) {
      const ok = q.headers.authorization === 'Bearer tok-123';
      return json(r, ok ? 200 : 401, { total: ok ? 3 : 0, autorizacion: q.headers.authorization || null });
    }
    if (u === '/no-existe') { return json(r, 404, { error: 'no existe' }); }
    if (u.startsWith('/sse')) {
      // Tres eventos espaciados: el panel tiene que pintarlos según llegan.
      r.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-ruta': u });
      r.write(': latido\n\n');
      const eventos = ['{"delta":"Hola"}', '{"delta":" mundo"}', '[DONE]'];
      let i = 0;
      const tic = setInterval(() => {
        if (i < eventos.length) {
          r.write(`id: ${i + 1}\nevent: token\ndata: ${eventos[i++]}\n\n`);
        } else {
          clearInterval(tic);
          r.end();
        }
      }, 200);
      return;
    }
    json(r, 200, eco(), { 'x-ruta': u });
  });
});

// --- WebSocket de eco: saluda al conectar y devuelve "eco: <mensaje>" ---------
s.on('upgrade', (q, socket) => {
  const clave = q.headers['sec-websocket-key'];
  if (!clave) { socket.destroy(); return; }
  const aceptar = crypto.createHash('sha1').update(clave + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${aceptar}`, '', ''].join('\r\n'));
  const enviar = (texto) => {
    const datos = Buffer.from(texto, 'utf8');
    const cabecera = datos.length < 126
      ? Buffer.from([0x81, datos.length])
      : Buffer.concat([Buffer.from([0x81, 126]), Buffer.from([(datos.length >> 8) & 0xff, datos.length & 0xff])]);
    socket.write(Buffer.concat([cabecera, datos]));
  };
  enviar(`hola ${q.headers['x-prueba'] || 'anonimo'}`);
  let resto = Buffer.alloc(0);
  socket.on('data', (trozo) => {
    resto = Buffer.concat([resto, trozo]);
    for (;;) {
      if (resto.length < 2) return;
      const op = resto[0] & 0x0f;
      const enmascarado = (resto[1] & 0x80) !== 0;
      let largo = resto[1] & 0x7f;
      let pos = 2;
      if (largo === 126) { if (resto.length < 4) return; largo = resto.readUInt16BE(2); pos = 4; }
      else if (largo === 127) { if (resto.length < 10) return; largo = Number(resto.readBigUInt64BE(2)); pos = 10; }
      const fin = pos + (enmascarado ? 4 : 0) + largo;
      if (resto.length < fin) return;
      let carga = resto.subarray(pos + (enmascarado ? 4 : 0), fin);
      if (enmascarado) {
        const mascara = resto.subarray(pos, pos + 4);
        carga = Buffer.from(carga.map((b, i) => b ^ mascara[i % 4]));
      }
      resto = resto.subarray(fin);
      if (op === 0x8) { socket.write(Buffer.from([0x88, 0])); socket.end(); return; }
      if (op === 0x9) { socket.write(Buffer.concat([Buffer.from([0x8a, carga.length]), carga])); continue; }
      if (op === 0x1) enviar(`eco: ${carga.toString('utf8')}`);
    }
  });
  socket.on('error', () => { /* el cliente se fue */ });
});

s.listen(0, host, () => console.log(JSON.stringify({ puerto: s.address().port })));
