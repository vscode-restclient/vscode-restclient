// Servidor de pruebas compartido por la suite de integración y la del runner.
//
// Responde lo justo para poder afirmar qué llegó: un eco por defecto, códigos
// de estado a demanda, JSON, XML, texto, redirección, lentitud, un stream SSE
// y un WebSocket de eco escrito a mano (RFC 6455, tramas de texto), para no
// meter una dependencia solo para probar.
//
//   node test-server.cjs [host]   -> imprime {"port": N}
const http = require('http');
const crypto = require('crypto');

const host = process.argv[2] || '127.0.0.1';

const json = (r, status, body, extra = {}) => {
  r.writeHead(status, { 'content-type': 'application/json', ...extra });
  r.end(JSON.stringify(body, null, 1));
};

const s = http.createServer((q, r) => {
  let b = '';
  q.on('data', c => b += c);
  q.on('end', () => {
    const u = q.url;
    const eco = () => ({ method: q.method, path: u, header: q.headers['x-test'] || null, agent: q.headers['user-agent'] || null, received: b });
    if (u.startsWith('/status/')) { const c = Number(u.split('/')[2]) || 500; return json(r, c, { error: 'oops', status: c }, { 'x-path': u }); }
    if (u === '/redirige') { r.writeHead(302, { location: '/destino' }); return r.end(); }
    if (u === '/slow') { return setTimeout(() => json(r, 200, eco(), { 'x-path': u }), 1500); }
    if (u === '/list') { return json(r, 200, { items: [{ id: 7 }, { id: 9 }] }, { 'x-path': u }); }
    if (u === '/json') { return json(r, 200, { nested: { a: 1, b: [1, 2, 3] } }, { 'x-path': u }); }
    if (u === '/text') { r.writeHead(200, { 'content-type': 'text/plain', 'x-path': u }); return r.end('plain text here'); }
    if (u === '/xml') { r.writeHead(200, { 'content-type': 'application/xml', 'x-path': u }); return r.end('<root><child>value</child></root>'); }
    if (u === '/auth') { return json(r, 200, { token: 'tok-123' }); }
    if (u.startsWith('/echo')) { return json(r, 200, { path: u, header: q.headers['x-test'] || null, authorization: q.headers.authorization || null, received: b }); }
    if (u.startsWith('/facturas')) {
      const ok = q.headers.authorization === 'Bearer tok-123';
      return json(r, ok ? 200 : 401, { total: ok ? 3 : 0, authorization: q.headers.authorization || null });
    }
    if (u === '/not-found') { return json(r, 404, { error: 'no existe' }); }
    if (u.startsWith('/sse')) {
      // Tres eventos espaciados: el panel tiene que pintarlos según llegan.
      r.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-path': u });
      r.write(': latido\n\n');
      const events = ['{"delta":"Hola"}', '{"delta":" mundo"}', '[DONE]'];
      let i = 0;
      const tic = setInterval(() => {
        if (i < events.length) {
          r.write(`id: ${i + 1}\nevent: token\ndata: ${events[i++]}\n\n`);
        } else {
          clearInterval(tic);
          r.end();
        }
      }, 200);
      return;
    }
    json(r, 200, eco(), { 'x-path': u });
  });
});

// --- WebSocket de eco: saluda al conectar y devuelve "eco: <mensaje>" ---------
s.on('upgrade', (q, socket) => {
  const key = q.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const aceptar = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${aceptar}`, '', ''].join('\r\n'));
  const enviar = (text) => {
    const data = Buffer.from(text, 'utf8');
    const header = data.length < 126
      ? Buffer.from([0x81, data.length])
      : Buffer.concat([Buffer.from([0x81, 126]), Buffer.from([(data.length >> 8) & 0xff, data.length & 0xff])]);
    socket.write(Buffer.concat([header, data]));
  };
  enviar(`hola ${q.headers['x-test'] || 'anonimo'}`);
  let resto = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    resto = Buffer.concat([resto, chunk]);
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

s.listen(0, host, () => console.log(JSON.stringify({ port: s.address().port })));
