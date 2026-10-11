/* Lanes - the example. A made-up web shop ("shopfront", 120 files) and five
 * branches, written out as the exact text the gather command produces, so
 * the example goes through the same parser as a real repo.
 *
 * Planted, and asserted by test/run.js to be exactly what the check finds:
 *   - agent/auth and agent/billing change the same lines of src/lib/db.ts;
 *   - both add migration 0042_*.sql;
 *   - both bump package.json's version (1.9.0 vs 1.8.1) and add a
 *     dependency, and both rewrite package-lock.json;
 *   - agent/search changes the line right after where agent/billing adds
 *     its route in src/routes/index.ts (touching lines: still a conflict);
 *     agent/auth adds its route further up (clean);
 *   - agent/search and agent/ui-polish each write a debounce helper, in
 *     different files;
 *   - agent/search hand-edits a generated API client;
 *   - agent/docs touches nothing anyone else does.
 * Every name, path, commit and line is invented.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LanesDemo = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MIGRATIONS = ['init', 'users', 'products', 'orders', 'order_items', 'addresses', 'product_images', 'categories', 'product_categories', 'inventory',
    'carts', 'cart_items', 'coupons', 'order_coupons', 'reviews', 'review_votes', 'wishlists', 'shipping_rates', 'tax_rates', 'audit_log',
    'user_roles', 'feature_flags', 'product_variants', 'variant_prices', 'stock_moves', 'returns', 'return_items', 'gift_cards', 'notifications', 'email_log',
    'search_terms', 'order_index_created_at', 'product_slug_unique', 'user_last_seen', 'carts_expire', 'order_notes', 'product_weight', 'shipping_zones', 'refunds', 'product_archived',
    'product_tags'];
  function pad(n) { return ('000' + n).slice(-4); }

  var FILES = [
    '.env.example', '.eslintrc.json', '.github/workflows/ci.yml', '.github/workflows/deploy.yml', '.gitignore', '.prettierrc',
    'CHANGELOG.md', 'CLAUDE.md', 'README.md', 'package-lock.json', 'package.json', 'tsconfig.json', 'vite.config.ts',
  ].concat(MIGRATIONS.map(function (m, i) { return 'db/migrations/' + pad(i + 1) + '_' + m + '.sql'; }), [
    'db/seed.sql',
    'docs/api.md', 'docs/architecture.md', 'docs/contributing.md', 'docs/deploy.md', 'docs/setup.md',
    'public/favicon.svg', 'public/robots.txt',
    'scripts/generate-client.ts', 'scripts/seed.ts',
    'src/App.tsx', 'src/main.tsx', 'src/server.ts',
    'src/api/__generated__/client.ts', 'src/api/__generated__/types.ts', 'src/api/http.ts',
    'src/components/Avatar.tsx', 'src/components/Badge.tsx', 'src/components/Button.tsx', 'src/components/EmptyState.tsx', 'src/components/Footer.tsx',
    'src/components/Header.tsx', 'src/components/Input.tsx', 'src/components/Modal.tsx', 'src/components/Price.tsx', 'src/components/ProductCard.tsx',
    'src/components/ProductList.tsx', 'src/components/Spinner.tsx', 'src/components/Toast.tsx',
    'src/hooks/useCart.ts', 'src/hooks/useOrders.ts', 'src/hooks/useProducts.ts', 'src/hooks/useUser.ts',
    'src/lib/cache.ts', 'src/lib/dates.ts', 'src/lib/db.ts', 'src/lib/env.ts', 'src/lib/flags.ts', 'src/lib/logger.ts', 'src/lib/money.ts', 'src/lib/validate.ts',
    'src/models/cart.ts', 'src/models/order.ts', 'src/models/product.ts', 'src/models/user.ts',
    'src/pages/Account.tsx', 'src/pages/Checkout.tsx', 'src/pages/Home.tsx', 'src/pages/NotFound.tsx', 'src/pages/Orders.tsx', 'src/pages/Product.tsx', 'src/pages/Products.tsx',
    'src/routes/cart.ts', 'src/routes/health.ts', 'src/routes/index.ts', 'src/routes/orders.ts', 'src/routes/products.ts', 'src/routes/users.ts',
    'src/styles/components.css', 'src/styles/global.css', 'src/styles/tokens.css',
    'tests/cart.test.ts', 'tests/db.test.ts', 'tests/money.test.ts', 'tests/orders.test.ts', 'tests/products.test.ts', 'tests/routes.test.ts',
  ]);

  /* ---- diff builders: exactly git's --unified=0 shapes ---- */

  function range(s, c) { return c === 1 ? String(s) : s + ',' + c; }
  /** A hunk: base start, removed lines, new start, added lines. */
  function H(os, minus, ns, plus) {
    var oc = minus.length, nc = plus.length;
    return ['@@ -' + range(os, oc) + ' +' + range(ns, nc) + ' @@'].concat(minus.map(function (l) { return '-' + l; }), plus.map(function (l) { return '+' + l; }));
  }
  var seq = 0;
  function blob() { seq++; return ((seq * 2654435761) >>> 0).toString(16).slice(0, 7).padStart(7, '0'); }
  function modified(path, hunks) {
    return ['diff --git a/' + path + ' b/' + path, 'index ' + blob() + '..' + blob() + ' 100644', '--- a/' + path, '+++ b/' + path].concat([].concat.apply([], hunks));
  }
  function added(path, lines) {
    return ['diff --git a/' + path + ' b/' + path, 'new file mode 100644', 'index 0000000..' + blob(), '--- /dev/null', '+++ b/' + path].concat(H(0, [], 1, lines));
  }

  var BRANCHES = [
    {
      name: 'agent/auth', author: 'Claude Code',
      commits: ['Add magic-link sign-in', 'Store sessions in Postgres', 'Add sessions migration', 'Wire auth routes', 'Bump version to 1.9.0', 'Tests for session expiry'],
      diff: [
        modified('package-lock.json', [
          H(3, ['  "version": "1.8.0",'], 3, ['  "version": "1.9.0",']),
          H(9, ['      "version": "1.8.0",'], 9, ['      "version": "1.9.0",']),
          H(14, [], 15, ['        "jose": "^5.9.6",']),
          H(1210, [], 1212, ['    "node_modules/jose": {', '      "version": "5.9.6",', '      "resolved": "https://registry.npmjs.org/jose/-/jose-5.9.6.tgz",', '      "integrity": "sha512-EXAMPLEONLY",', '      "funding": {', '        "url": "https://example.invalid/funding"', '      }', '    },']),
        ]),
        modified('package.json', [
          H(3, ['  "version": "1.8.0",'], 3, ['  "version": "1.9.0",']),
          H(22, [], 23, ['    "jose": "^5.9.6",']),
        ]),
        added('db/migrations/0042_add_sessions.sql', ['CREATE TABLE sessions (', '  id uuid PRIMARY KEY,', '  user_id bigint NOT NULL REFERENCES users(id),', '  token_hash text NOT NULL,', '  created_at timestamptz NOT NULL DEFAULT now(),', '  expires_at timestamptz NOT NULL', ');', '', 'CREATE INDEX sessions_user_id ON sessions (user_id);']),
        modified('src/lib/db.ts', [
          H(40, ['  max: 10,', '  idleTimeoutMillis: 30_000,', '  connectionTimeoutMillis: 2_000,', '});', '', 'export async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {'],
            40, ['  max: 20,', '  idleTimeoutMillis: 10_000,', '  connectionTimeoutMillis: 2_000,', '});', '', 'export async function withSessionTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {', '  return withTx(fn);', '}', '', 'export async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {']),
        ]),
        modified('src/routes/index.ts', [
          H(3, [], 4, ["import { authRoutes } from './auth';"]),
          H(14, [], 16, ["router.use('/auth', authRoutes);"]),
        ]),
        added('src/auth/session.ts', ["import { query } from '../lib/db';", "import { randomToken, hashToken } from './tokens';", '', 'const DAY = 24 * 60 * 60 * 1000;', '', 'export async function createSession(userId: number) {', '  const token = randomToken();', "  await query('INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (gen_random_uuid(), $1, $2, $3)', [userId, hashToken(token), new Date(Date.now() + 30 * DAY)]);", '  return token;', '}', '', 'export async function revokeSession(token: string) {', "  await query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);", '}']),
        added('src/auth/magicLink.ts', ["import { createSession } from './session';", '', 'export async function sendMagicLink(email: string) {', '  // queue the email; never reveal whether the address has an account', '  return { ok: true };', '}', '', 'export async function verifyMagicLink(token: string) {', '  const userId = await consume(token);', '  return userId ? createSession(userId) : null;', '}']),
        added('src/routes/auth.ts', ["import { Router } from 'express';", "import { sendMagicLink, verifyMagicLink } from '../auth/magicLink';", '', 'export const authRoutes = Router();', '', "authRoutes.post('/link', async (req, res) => res.json(await sendMagicLink(req.body.email)));", "authRoutes.get('/verify', async (req, res) => res.json({ token: await verifyMagicLink(String(req.query.t)) }));"]),
        added('src/pages/SignIn.tsx', ["import { Button } from '../components/Button';", '', 'export default function SignIn() {', '  return <form className="sign-in"><input type="email" name="email" /><Button>Email me a link</Button></form>;', '}']),
        added('tests/auth.test.ts', ["import { createSession } from '../src/auth/session';", '', "test('a session expires after 30 days', async () => {", '  expect(await createSession(1)).toHaveLength(43);', '});']),
      ],
    },
    {
      name: 'agent/billing', author: 'Codex',
      commits: ['Add invoices table', 'Stripe client and webhook', 'Invoice totals with tax', 'Billing page', 'Bump version'],
      diff: [
        modified('package-lock.json', [
          H(3, ['  "version": "1.8.0",'], 3, ['  "version": "1.8.1",']),
          H(9, ['      "version": "1.8.0",'], 9, ['      "version": "1.8.1",']),
          H(17, [], 18, ['        "stripe": "^17.3.1",']),
          H(2034, [], 2036, ['    "node_modules/stripe": {', '      "version": "17.3.1",', '      "resolved": "https://registry.npmjs.org/stripe/-/stripe-17.3.1.tgz",', '      "integrity": "sha512-EXAMPLEONLY",', '      "dependencies": {', '        "@types/node": ">=8.1.0",', '        "qs": "^6.11.0"', '      },', '      "engines": {', '        "node": ">=12.*"', '      }', '    },']),
        ]),
        modified('package.json', [
          H(3, ['  "version": "1.8.0",'], 3, ['  "version": "1.8.1",']),
          H(25, [], 26, ['    "stripe": "^17.3.1",']),
        ]),
        added('db/migrations/0042_add_invoices.sql', ['CREATE TABLE invoices (', '  id bigserial PRIMARY KEY,', '  order_id bigint NOT NULL REFERENCES orders(id),', '  stripe_invoice_id text UNIQUE,', '  subtotal_cents integer NOT NULL,', '  tax_cents integer NOT NULL,', "  status text NOT NULL DEFAULT 'draft',", '  created_at timestamptz NOT NULL DEFAULT now()', ');', '', 'CREATE INDEX invoices_order_id ON invoices (order_id);', "CREATE INDEX invoices_status ON invoices (status) WHERE status <> 'paid';"]),
        modified('src/lib/db.ts', [
          H(44, ['', 'export async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {', '  const { rows } = await pool.query(sql, params);', '  return rows as T[];', '}', '', 'export async function withTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {', '  const client = await pool.connect();'],
            44, ['', 'export async function query<T>(sql: string, params: unknown[] = [], opts: { timeoutMs?: number } = {}): Promise<T[]> {', '  const { rows } = await pool.query({ text: sql, values: params, query_timeout: opts.timeoutMs });', '  return rows as T[];', '}', '', 'export async function withInvoiceTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {', "  return withTx(fn, { isolation: 'serializable' });", '}', '', 'export async function withTx<T>(fn: (c: PoolClient) => Promise<T>, opts: TxOptions = {}): Promise<T> {', '  const client = await pool.connect();']),
        ]),
        modified('src/routes/index.ts', [
          H(5, [], 6, ["import { billingRoutes } from './billing';"]),
          H(16, [], 18, ["router.use('/billing', billingRoutes);"]),
        ]),
        added('src/billing/invoices.ts', ["import { withInvoiceTx } from '../lib/db';", "import { toCents } from '../lib/money';", '', 'export async function createInvoice(orderId: number) {', '  return withInvoiceTx(async (c) => {', "    const { rows } = await c.query('SELECT subtotal_cents FROM orders WHERE id = $1', [orderId]);", '    return rows[0];', '  });', '}', '', 'export function invoiceTotal(subtotalCents: number, taxRate: number) {', '  return subtotalCents + Math.round(subtotalCents * taxRate);', '}']),
        added('src/billing/stripe.ts', ["import Stripe from 'stripe';", "import { env } from '../lib/env';", '', "export const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2024-10-28.acacia' });"]),
        added('src/routes/billing.ts', ["import { Router } from 'express';", "import { createInvoice } from '../billing/invoices';", '', 'export const billingRoutes = Router();', '', "billingRoutes.post('/invoices', async (req, res) => res.json(await createInvoice(Number(req.body.orderId))));"]),
        added('src/pages/Billing.tsx', ["import { Price } from '../components/Price';", '', 'export default function Billing() {', '  return <section className="billing"><h1>Invoices</h1></section>;', '}']),
        added('tests/billing.test.ts', ["import { invoiceTotal } from '../src/billing/invoices';", '', "test('tax is rounded to the cent', () => {", '  expect(invoiceTotal(1999, 0.0825)).toBe(2164);', '});']),
      ],
    },
    {
      name: 'agent/search', author: 'Cursor Agent',
      commits: ['Search box in the header', 'Client-side search index', 'Debounce the search input', 'Add searchProducts to the API client'],
      diff: [
        modified('src/api/__generated__/client.ts', [
          H(88, [], 89, ['', 'export async function searchProducts(q: string): Promise<Product[]> {', "  const res = await http.get('/products', { params: { q } });", '  return res.data;', '}', '']),
        ]),
        modified('src/components/Header.tsx', [
          H(12, ['      <nav className="header-nav">', '        <Link to="/products">Shop</Link>'], 12, ['      <nav className="header-nav">', '        <Link to="/products">Shop</Link>', '        <SearchBox />', '      </nav>']),
        ]),
        modified('src/routes/index.ts', [
          H(6, [], 7, ["import { withSearch } from '../features/search/withSearch';"]),
          H(17, ["router.use('/products', productRoutes);"], 18, ["router.use('/products', withSearch(productRoutes));"]),
        ]),
        added('src/features/search/SearchBox.tsx', ["import { useState } from 'react';", "import { useDebouncedValue } from './useDebounce';", '', 'export function SearchBox() {', "  const [q, setQ] = useState('');", '  const term = useDebouncedValue(q, 250);', '  return <input type="search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search products" data-term={term} />;', '}']),
        added('src/features/search/useDebounce.ts', ["import { useEffect, useState } from 'react';", '', 'export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {', '  let t: ReturnType<typeof setTimeout> | undefined;', '  return (...args: A) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };', '}', '', 'export function useDebouncedValue<T>(value: T, ms: number) {', '  const [v, setV] = useState(value);', '  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);', '  return v;', '}']),
        added('src/features/search/searchIndex.ts', ["import type { Product } from '../../models/product';", '', 'export function buildSearchIndex(products: Product[]) {', '  return products.map((p) => ({ id: p.id, text: (p.name + " " + p.tags.join(" ")).toLowerCase() }));', '}']),
        added('src/features/search/withSearch.ts', ["import type { Router } from 'express';", '', 'export function withSearch(routes: Router) {', '  return routes;', '}']),
        added('tests/search.test.ts', ["import { buildSearchIndex } from '../src/features/search/searchIndex';", '', "test('indexes names and tags', () => {", "  expect(buildSearchIndex([])).toEqual([]);", '});']),
      ],
    },
    {
      name: 'agent/ui-polish', author: 'Claude Code',
      commits: ['Button sizes and focus ring', 'Friendlier empty states', 'Smaller spinner', 'Toasts wait for typing to stop', 'Spacing tokens', 'Tidy component styles', 'Contrast fixes'],
      diff: [
        modified('src/components/Button.tsx', [
          H(8, ["export function Button({ variant = 'primary', ...props }: ButtonProps) {", '  return <button className={`btn btn-${variant}`} {...props} />;'],
            8, ["export function Button({ variant = 'primary', size = 'md', ...props }: ButtonProps) {", '  return <button className={`btn btn-${variant} btn-${size}`} {...props} />;']),
        ]),
        modified('src/components/EmptyState.tsx', [
          H(5, ['  return <p className="empty">Nothing here.</p>;'], 5, ['  return (', '    <div className="empty" role="status">', '      <p className="empty-title">{title}</p>', '      {hint ? <p className="empty-hint">{hint}</p> : null}', '    </div>', '  );']),
        ]),
        modified('src/components/Spinner.tsx', [
          H(3, ['  return <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true">'], 3, ['  return <svg width="20" height="20" viewBox="0 0 32 32" aria-label="Loading" role="img">']),
        ]),
        modified('src/components/Toast.tsx', [
          H(2, [], 3, ["import { debounce } from '../lib/debounce';"]),
          H(20, ['  const show = (m: string) => setMessage(m);'], 21, ['  const show = debounce((m: string) => setMessage(m), 300);']),
        ]),
        added('src/lib/debounce.ts', ['export function debounce<T extends (...args: never[]) => void>(fn: T, wait = 200) {', '  let timer: ReturnType<typeof setTimeout> | null = null;', '  return (...args: Parameters<T>) => {', '    if (timer) clearTimeout(timer);', '    timer = setTimeout(() => fn(...args), wait);', '  };', '}']),
        modified('src/styles/tokens.css', [
          H(14, ['  --space-2: 6px;', '  --space-3: 10px;'], 14, ['  --space-2: 8px;', '  --space-3: 12px;', '  --space-4: 16px;']),
        ]),
        modified('src/styles/components.css', [
          H(40, ['.btn { padding: 6px 12px; }'], 40, ['.btn { padding: var(--space-2) var(--space-4); }', '.btn-sm { padding: 4px var(--space-3); }', '.btn:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }']),
        ]),
      ],
    },
    {
      name: 'agent/docs', author: 'Aider',
      commits: ['Setup guide: Node 22 and the seed script', 'Deploy notes for the staging database'],
      diff: [
        modified('docs/setup.md', [
          H(12, ['1. Install Node 20.', '2. `npm install`'], 12, ['1. Install Node 22 (see `.nvmrc`).', '2. `npm ci`', '3. Copy `.env.example` to `.env` and fill in `DATABASE_URL`.', '4. `npm run db:migrate && npm run db:seed`']),
        ]),
        modified('docs/deploy.md', [
          H(30, [], 31, ['', '## Staging database', '', 'Staging runs every migration on deploy. Take a snapshot first:', '', '    npm run db:snapshot -- --env staging']),
        ]),
      ],
    },
  ];

  var ANCHOR = Date.parse('2026-10-09T09:00:00Z');
  /** The gather file, exactly as the command writes it. */
  function gather() {
    seq = 0;
    var out = ['#lanes v1 base=main', '#lanes files'].concat(FILES);
    BRANCHES.forEach(function (b, bi) {
      out.push('#lanes branch ' + b.name, '#lanes log');
      var n = b.commits.length;
      for (var i = n - 1; i >= 0; i--) {
        var t = new Date(ANCHOR + bi * 3600e3 + i * 1500e3).toISOString().replace('.000Z', '+00:00');
        var sha = ((((bi + 1) * 7919 + i * 104729) * 2654435761) >>> 0).toString(16).padStart(8, '0').slice(0, 7);
        out.push(sha + '\t' + b.author + '\t' + t + '\t' + b.commits[i]);
      }
      out.push('#lanes diff');
      out.push.apply(out, b.diff.flat ? b.diff.flat() : [].concat.apply([], b.diff));
    });
    out.push('#lanes end');
    return out.join('\n') + '\n';
  }

  /** The example plan: the same repo, before any agent started. */
  var TASKS = [
    'Sign in with magic links and sessions',
    'Invoices and Stripe billing',
    'Search the product list from the header',
    'Polish buttons, empty states and spacing',
  ];
  function plan() {
    return {
      tasks: TASKS.slice(),
      base: 'main', prefix: 'agent/', repo: 'shopfront', lead: 'Priya (the lead)',
      lanes: [
        { name: 'auth', task: TASKS[0], owns: ['src/auth/**', 'src/routes/auth.ts', 'src/pages/SignIn.tsx', 'src/models/user.ts', 'tests/auth.test.ts'], readOnly: ['src/lib/**'], notes: '', migrations: null },
        { name: 'billing', task: TASKS[1], owns: ['src/billing/**', 'src/routes/billing.ts', 'src/pages/Billing.tsx', 'src/lib/money.ts', 'tests/billing.test.ts'], readOnly: ['src/lib/**', 'src/models/**'], notes: '', migrations: null },
        { name: 'search', task: TASKS[2], owns: ['src/features/search/**', 'src/components/Header.tsx', 'tests/search.test.ts'], readOnly: ['src/models/product.ts'], notes: '', migrations: null },
        { name: 'ui-polish', task: TASKS[3], owns: ['src/components/**', 'src/styles/**', '!src/components/ProductList.tsx'], readOnly: [], notes: '', migrations: null },
      ],
      rules: {},
    };
  }

  return {
    REPO: 'shopfront', BASE: 'main',
    files: function () { return FILES.slice(); },
    gather: gather,
    tasks: function () { return TASKS.slice(); },
    plan: plan,
    BRANCH_NAMES: BRANCHES.map(function (b) { return b.name; }),
  };
}));
