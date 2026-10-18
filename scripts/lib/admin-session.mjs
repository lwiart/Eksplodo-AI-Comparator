// Session Admin sur l'API de l'application, pour les scripts d'import et d'export de tests.
// L'e-mail et le mot de passe sont demandés au clavier (mot de passe masqué) ou lus dans AIC_EMAIL et AIC_PASSWORD.
import { createInterface } from 'node:readline';

/** Question posée au clavier ; `hidden` masque la saisie (mot de passe). */
export function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => {
        if (s.startsWith(question)) rl.output.write(s);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

/** Ouvre une session Admin ; renvoie `call` (JSON), `download` (binaire) et `close` (déconnexion). */
export async function openAdminSession(baseUrl) {
  const cookies = new Map();
  const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const keep = (res) => {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const eq = pair.indexOf('=');
      cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  };
  async function raw(method, path, body) {
    const headers = { cookie: cookieHeader() };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET' && cookies.has('aic_csrf')) headers['x-csrf-token'] = cookies.get('aic_csrf');
    const res = await fetch(baseUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    keep(res);
    return res;
  }
  async function call(method, path, body) {
    const res = await raw(method, path, body);
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(`${method} ${path} : ${res.status} ${json?.error?.message ?? text.slice(0, 200)}`);
    return json;
  }
  async function download(path) {
    const res = await raw('GET', path);
    if (!res.ok) throw new Error(`GET ${path} : ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  const email = process.env.AIC_EMAIL || (await ask('E-mail Admin : '));
  const password = process.env.AIC_PASSWORD || (await ask('Mot de passe : ', true));
  await raw('GET', '/api/auth/me'); // obtient le cookie CSRF
  await call('POST', '/api/auth/login', { email, password });
  const me = (await call('GET', '/api/auth/me')).user;
  if (me?.role !== 'admin') throw new Error('Ce compte n\'est pas Admin.');
  return {
    call,
    download,
    close: () => call('POST', '/api/auth/logout').catch(() => {}),
  };
}

/** Lecture simple des options : `--nom valeur`, `--drapeau`, et le premier argument libre. */
export function readArgs(argv) {
  const option = (name, fallback) => {
    const i = argv.indexOf(name);
    return i === -1 ? fallback : argv[i + 1];
  };
  const valued = new Set(argv.flatMap((a, i) => (a.startsWith('--') && argv[i + 1] && !argv[i + 1].startsWith('--') ? [i + 1] : [])));
  const free = argv.find((a, i) => !a.startsWith('--') && !valued.has(i));
  return { option, flag: (name) => argv.includes(name), free };
}
