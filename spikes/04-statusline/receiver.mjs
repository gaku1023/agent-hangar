// spikes/04-statusline/receiver.mjs
import http from 'node:http';
import fs from 'node:fs';
const out = process.argv[2] ?? '/tmp/spike04-first.json';
let n = 0, last = 0;
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => body += c);
  req.on('end', () => {
    const now = Date.now(); n++;
    try {
      const d = JSON.parse(body);
      if (n === 1) fs.writeFileSync(out, JSON.stringify(d, null, 2));
      console.log(`#${n} +${last ? now - last : 0}ms`, JSON.stringify({
        five: d.rate_limits?.five_hour, seven: d.rate_limits?.seven_day,
        model: d.model?.display_name, ctx: d.context_window?.current_usage, keys: Object.keys(d),
      }));
    } catch { console.log(`#${n} parse error`, body.slice(0, 200)); }
    last = now; res.end('ok');
  });
}).listen(4192, '127.0.0.1', () => console.log('receiver on 4192'));
