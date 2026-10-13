/* Triage - the example. A made-up AI-written pull request, "Add team
 * invitations" on a made-up app ("crewdeck"), written out as the exact text
 * `git diff --stat -M` + `git diff -M` produce, so the example goes through
 * the same parser as a real PR.
 *
 * Planted, and asserted by test/run.js to be exactly what Triage finds:
 *   - THE ONE THAT MATTERS: src/server/teams/access.ts looks like a prettier
 *     reformat (four of its five hunks are), but its third hunk changes
 *     canManageTeam so any non-viewer - a plain member - can now manage a
 *     team. It must rank first.
 *   - a new SQL migration (db/migrations/0018_team_invitations.sql);
 *   - a new API route with no test (src/server/routes/invitations.ts), which
 *     also swallows an e-mail error and leaves a TODO;
 *   - the invitation service, with raw SQL and token handling - and a test;
 *   - a configuration default changed (INVITE_TTL_DAYS 7 -> 30) and a
 *     feature flag, in src/server/config.ts and .env.example;
 *   - a new dependency (nanoid) in package.json;
 *   - the noise: a folder moved (six 100% renames, three files' imports
 *     following it), a mass rename (getTeamMembers -> listTeamMembers in six
 *     files), a prettier reformat of nine files, four snapshot files,
 *     package-lock.json churn, a regenerated API client, imports reordered,
 *     and the changelog.
 * Every name, path and line is invented.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TriageDemo = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var seed = 20261013;
  function rnd() { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; }
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function hash(n) { var s = ''; for (var i = 0; i < n; i++) s += B64.charAt(Math.floor(rnd() * 64)); return s; }
  function hex(n) { var s = ''; for (var i = 0; i < n; i++) s += '0123456789abcdef'.charAt(Math.floor(rnd() * 16)); return s; }

  /* ---------------- building a diff ---------------- */

  var out = [], stat = [];
  function hunk(os, ns, lines) {
    var oc = 0, nc = 0;
    lines.forEach(function (l) { if (l[0] !== '+') oc++; if (l[0] !== '-') nc++; });
    var head = '@@ -' + os + (oc === 1 ? '' : ',' + oc) + ' +' + ns + (nc === 1 ? '' : ',' + nc) + ' @@';
    return [head].concat(lines.map(function (l) { return l[0] + l[1]; }));
  }
  function count(hunks) {
    var a = 0, d = 0;
    hunks.forEach(function (h) { h.forEach(function (l, i) { if (i === 0) return; if (l.charAt(0) === '+') a++; else if (l.charAt(0) === '-') d++; }); });
    return [a, d];
  }
  function mod(p, hunks) {
    out.push('diff --git a/' + p + ' b/' + p, 'index ' + hex(7) + '..' + hex(7) + ' 100644', '--- a/' + p, '+++ b/' + p);
    hunks.forEach(function (h) { out.push.apply(out, h); });
    stat.push([p, count(hunks)]);
  }
  function add(p, lines) {
    var h = hunk(0, 1, lines.map(function (l) { return ['+', l]; }));
    out.push('diff --git a/' + p + ' b/' + p, 'new file mode 100644', 'index 0000000..' + hex(7), '--- /dev/null', '+++ b/' + p);
    out.push.apply(out, h.map(function (l, i) { return i === 0 ? '@@ -0,0 +1,' + lines.length + ' @@' : l; }));
    stat.push([p, [lines.length, 0]]);
  }
  function rename(from, to) {
    out.push('diff --git a/' + from + ' b/' + to, 'similarity index 100%', 'rename from ' + from, 'rename to ' + to);
    stat.push(['{' + from + ' => ' + to + '}', [0, 0]]);
  }
  /** A prettier run: 4-space indents become 2, double-quoted strings
   *  single (not JSX attributes, not strings holding a quote), and a
   *  trailing comma where the old source marks one with a /*,*\/ sentinel. */
  function restyle(line) {
    var m = /^( *)(.*)$/.exec(line);
    var ind = m[1].slice(0, Math.floor(m[1].length / 2));
    var body = m[2].replace(/\/\*,\*\//g, ',');
    body = body.replace(/(^|[^=\w])"([^"'\\]*)"/g, "$1'$2'");
    return ind + body;
  }
  function plain(line) { return line.replace(/\/\*,\*\//g, ''); }
  /** A whole file reformatted section by section: one hunk per section, the
   *  blank line between sections as context. `changed` maps a section index
   *  to its new lines, for a section that also changes for real. */
  function reformat(p, sections, changed) {
    var hunks = [], line = 1, delta = 0;
    sections.forEach(function (sec, k) {
      var oldL = sec.map(plain);
      var newL = changed && changed[k] ? changed[k] : sec.map(restyle);
      var lines = [];
      if (k > 0) lines.push([' ', '']);
      oldL.forEach(function (l) { lines.push(['-', l]); });
      newL.forEach(function (l) { lines.push(['+', l]); });
      if (k < sections.length - 1) lines.push([' ', '']);
      var os = k > 0 ? line - 1 : line;
      hunks.push(hunk(os, os + delta, lines));
      delta += newL.length - oldL.length;
      line += oldL.length + 1;
    });
    mod(p, hunks);
  }

  /* ---------------- the noise ---------------- */

  function lockfile() {
    var parts = ['ansi', 'chalk', 'debug', 'glob', 'minimatch', 'semver', 'yargs', 'picomatch', 'braces', 'fill', 'micro', 'tslib', 'acorn', 'esquery', 'postcss', 'rollup', 'vite', 'esbuild', 'undici', 'ws', 'mime', 'qs', 'cookie', 'send', 'etag', 'fresh', 'vary', 'bytes', 'depd', 'statuses'];
    var tails = ['', '-utils', '-core', '-parser', '-types', '-regex', '-match', '-compat'];
    var hunks = [], line = 120;
    hunks.push(hunk(14, 14, [[' ', '        "express": "^4.21.1",'], [' ', '        "kysely": "^0.27.4",'], ['+', '        "nanoid": "^5.0.7",'], [' ', '        "pg": "^8.13.0",'], [' ', '        "zod": "^3.23.8"']]));
    var delta = 1;
    for (var i = 0; i < 170; i++) {
      var name = parts[i % parts.length] + tails[Math.floor(i / parts.length) % tails.length];
      var maj = 1 + Math.floor(rnd() * 6), min = Math.floor(rnd() * 20), pat = Math.floor(rnd() * 9);
      var v1 = maj + '.' + min + '.' + pat, v2 = maj + '.' + min + '.' + (pat + 1);
      var lines = [
        [' ', '    "node_modules/' + name + '": {'],
        ['-', '      "version": "' + v1 + '",'],
        ['-', '      "resolved": "https://registry.npmjs.org/' + name + '/-/' + name + '-' + v1 + '.tgz",'],
        ['-', '      "integrity": "sha512-' + hash(86) + '==",'],
        ['+', '      "version": "' + v2 + '",'],
        ['+', '      "resolved": "https://registry.npmjs.org/' + name + '/-/' + name + '-' + v2 + '.tgz",'],
        ['+', '      "integrity": "sha512-' + hash(86) + '==",'],
        [' ', '      "dev": true,'],
      ];
      hunks.push(hunk(line, line + delta, lines));
      line += 24 + Math.floor(rnd() * 30);
    }
    var nano = [
      [' ', '    },'],
      ['+', '    "node_modules/nanoid": {'],
      ['+', '      "version": "5.0.7",'],
      ['+', '      "resolved": "https://registry.npmjs.org/nanoid/-/nanoid-5.0.7.tgz",'],
      ['+', '      "integrity": "sha512-' + hash(86) + '==",'],
      ['+', '      "bin": {'],
      ['+', '        "nanoid": "bin/nanoid.js"'],
      ['+', '      },'],
      ['+', '      "engines": {'],
      ['+', '        "node": "^18 || >=20"'],
      ['+', '      }'],
      ['+', '    },'],
      [' ', '    "node_modules/negotiator": {'],
    ];
    hunks.push(hunk(line + 40, line + 40 + delta, nano));
    mod('package-lock.json', hunks);
  }

  function generatedClient() {
    var schemas = ['TeamInvitation', 'CreateInvitationRequest', 'CreateInvitationResponse', 'InvitationPreview', 'AcceptInvitationResponse', 'InvitationList', 'InvitationStatus', 'TeamMemberSummary', 'TeamSummary', 'ApiError', 'RevokeInvitationResponse', 'ResendInvitationResponse', 'InvitationEvent', 'InvitationAudit', 'PendingInvitation', 'InvitationCounts'];
    var fields = [['id', 'string'], ['teamId', 'string'], ['email', 'string'], ['level', '"member" | "viewer"'], ['status', 'components["schemas"]["InvitationStatus"]'], ['invitedBy', 'string'], ['expiresAt', 'string'], ['acceptedAt', 'string | null'], ['createdAt', 'string'], ['teamName', 'string'], ['inviterName', 'string'], ['count', 'number']];
    var added = [];
    schemas.forEach(function (s, k) {
      added.push('    ' + s + ': {');
      for (var j = 0; j < 6 + (k % 5); j++) {
        var f = fields[(k * 3 + j) % fields.length];
        added.push('      /** @description ' + f[0].replace(/([A-Z])/g, ' $1').toLowerCase() + ' */');
        added.push('      ' + f[0] + (j % 4 === 3 ? '?' : '') + ': ' + f[1] + ';');
      }
      added.push('    };');
    });
    var ops = ['createInvitation', 'listInvitations', 'getInvitation', 'acceptInvitation', 'revokeInvitation', 'resendInvitation'];
    var opsLines = [];
    ops.forEach(function (o, k) {
      opsLines.push('  ' + o + ': {');
      opsLines.push('    parameters: {');
      opsLines.push('      path: {');
      opsLines.push(k < 2 ? '        teamId: string;' : '        invitationId: string;');
      opsLines.push('      };');
      opsLines.push('    };');
      if (k === 0) { opsLines.push('    requestBody: {'); opsLines.push('      content: {'); opsLines.push('        "application/json": components["schemas"]["CreateInvitationRequest"];'); opsLines.push('      };'); opsLines.push('    };'); }
      opsLines.push('    responses: {');
      ['200', '400', '403', '404'].forEach(function (code) {
        opsLines.push('      ' + code + ': {');
        opsLines.push('        content: {');
        opsLines.push('          "application/json": components["schemas"]["' + (code === '200' ? schemas[k % 6] : 'ApiError') + '"];');
        opsLines.push('        };');
        opsLines.push('      };');
      });
      opsLines.push('    };');
      opsLines.push('  };');
    });
    var paths = [];
    ['/teams/{teamId}/invitations', '/invitations/{invitationId}', '/invitations/{invitationId}/accept', '/invitations/{invitationId}/resend'].forEach(function (p, k) {
      paths.push('  "' + p + '": {');
      paths.push('    ' + (k === 0 ? 'get: operations["listInvitations"];' : 'get: operations["getInvitation"];'));
      paths.push('    ' + (k === 0 ? 'post: operations["createInvitation"];' : k === 1 ? 'delete: operations["revokeInvitation"];' : 'post: operations["' + (k === 2 ? 'acceptInvitation' : 'resendInvitation') + '"];'));
      paths.push('  };');
    });
    var hunks = [];
    hunks.push(hunk(1, 1, [[' ', '// @generated by openapi-typescript 7.4.0 - DO NOT EDIT.'], [' ', '// Source: openapi.yaml'], ['-', '// Generated at 2026-09-30T11:02:41Z'], ['+', '// Generated at 2026-10-13T05:47:12Z'], [' ', '']]));
    hunks.push(hunk(18, 18, [[' ', 'export interface paths {']].concat(paths.map(function (l) { return ['+', l]; })).concat([[' ', '  "/teams/{teamId}/members": {']])));
    var d = paths.length;
    hunks.push(hunk(140, 140 + d, [[' ', 'export interface components {'], [' ', '  schemas: {']].concat(added.map(function (l) { return ['+', l]; })).concat([[' ', '    Team: {']])));
    d += added.length;
    hunks.push(hunk(410, 410 + d, [[' ', 'export interface operations {']].concat(opsLines.map(function (l) { return ['+', l]; })).concat([[' ', '  getTeam: {']])));
    mod('src/web/client/generated/api.ts', hunks);
  }

  function snapshot(p, name, rows) {
    var hunks = [], line = 3;
    for (var k = 0; k < rows; k++) {
      var cls = ['btn', 'card', 'row', 'stack', 'chip', 'badge'][k % 6];
      hunks.push(hunk(line, line, [
        [' ', 'exports[`' + name + ' renders variant ' + (k + 1) + ' 1`] = `'],
        [' ', '<div'],
        ['-', '  className="' + cls + ' ' + cls + '-' + (k + 1) + '"'],
        ['-', '  data-testid="' + name.toLowerCase() + '-' + (k + 1) + '"'],
        ['+', '  className="' + cls + ' ' + cls + '--' + (k + 1) + ' ' + cls + '--theme-light"'],
        ['+', '  data-testid="' + name.toLowerCase() + '-' + (k + 1) + '"'],
        ['+', '  data-variant="' + (k % 2 ? 'outline' : 'solid') + '"'],
        [' ', '>'],
        ['-', '  <span className="label">Item ' + (k + 1) + '</span>'],
        ['+', '  <span className="' + cls + '__label">Item ' + (k + 1) + '</span>'],
        [' ', '</div>'],
      ]));
      line += 14;
    }
    mod(p, hunks);
  }

  /* ---------------- the reformatted files (prettier) ---------------- */

  var BUTTON = [
    ['import { forwardRef } from "react";', 'import type { ButtonHTMLAttributes } from "react";'],
    ['type Variant = "primary" | "ghost" | "danger";'],
    ['export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {', '    variant?: Variant;', '    busy?: boolean;', '}'],
    ['export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(', '    { variant = "primary", busy = false, children, ...rest },', '    ref/*,*/', ') {', '    return (', '        <button ref={ref} className={"btn btn-" + variant} aria-busy={busy} {...rest}>', '            {busy ? "Working…" : children}', '        </button>', '    );', '});'],
  ];
  var MODAL = [
    ['import { useEffect, useRef } from "react";', 'import { createPortal } from "react-dom";'],
    ['export interface ModalProps {', '    title: string;', '    open: boolean;', '    onClose: () => void;', '    children: React.ReactNode;', '}'],
    ['export function Modal({ title, open, onClose, children }: ModalProps) {', '    const ref = useRef<HTMLDivElement>(null);', '    useEffect(() => {', '        if (!open) return;', '        const onKey = (e: KeyboardEvent) => {', '            if (e.key === "Escape") onClose();', '        };', '        document.addEventListener("keydown", onKey);', '        return () => document.removeEventListener("keydown", onKey);', '    }, [open, onClose]);', '    if (!open) return null;', '    return createPortal(', '        <div className="modal-back" onClick={onClose}>', '            <div ref={ref} className="modal" aria-label={title} onClick={(e) => e.stopPropagation()}>', '                <h2>{title}</h2>', '                {children}', '            </div>', '        </div>,', '        document.body/*,*/', '    );', '}'],
  ];
  var FORMAT = [
    ['const LOCALE = "en-US";'],
    ['export function formatCount(n: number, one: string, many: string): string {', '    return n === 1 ? "1 " + one : n.toLocaleString(LOCALE) + " " + many;', '}'],
    ['export function initials(name: string): string {', '    return name', '        .split(" ")', '        .filter(Boolean)', '        .slice(0, 2)', '        .map((part) => part[0].toUpperCase())', '        .join("");', '}'],
    ['export function truncate(text: string, max = 80): string {', '    if (text.length <= max) return text;', '    return text.slice(0, max - 1) + "…";', '}'],
    ['export const PLURALS = {', '    member: ["member", "members"],', '    team: ["team", "teams"],', '    invite: ["invite", "invites"]/*,*/', '};'],
  ];
  var DATES = [
    ['const DAY = 24 * 60 * 60 * 1000;'],
    ['export function daysBetween(a: Date, b: Date): number {', '    return Math.round((b.getTime() - a.getTime()) / DAY);', '}'],
    ['export function relative(date: Date, now = new Date()): string {', '    const days = daysBetween(date, now);', '    if (days === 0) return "today";', '    if (days === 1) return "yesterday";', '    if (days < 7) return days + " days ago";', '    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });', '}'],
    ['export function addDays(date: Date, days: number): Date {', '    return new Date(date.getTime() + days * DAY);', '}'],
    ['export function isPast(date: Date, now = new Date()): boolean {', '    return date.getTime() < now.getTime();', '}'],
  ];
  var LOGGER = [
    ['type Level = "debug" | "info" | "warn" | "error";'],
    ['const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };'],
    ['export function createLogger(name: string, min: Level = "info") {', '    const log = (level: Level, msg: string, extra?: object) => {', '        if (ORDER[level] < ORDER[min]) return;', '        console.log(JSON.stringify({ level, name, msg, ...extra, at: new Date().toISOString() }));', '    };', '    return {', '        debug: (m: string, e?: object) => log("debug", m, e),', '        info: (m: string, e?: object) => log("info", m, e),', '        warn: (m: string, e?: object) => log("warn", m, e),', '        error: (m: string, e?: object) => log("error", m, e)/*,*/', '    };', '}'],
  ];
  var ERRORS = [
    ['export class AppError extends Error {', '    constructor(', '        public status: number,', '        message: string,', '        public code = "app_error"/*,*/', '    ) {', '        super(message);', '    }', '}'],
    ['export const notFound = (what: string) => new AppError(404, what + " not found", "not_found");'],
    ['export const badRequest = (why: string) => new AppError(400, why, "bad_request");'],
    ['export function toBody(err: unknown) {', '    if (err instanceof AppError) return { status: err.status, body: { error: err.message, code: err.code } };', '    return { status: 500, body: { error: "Something went wrong.", code: "internal" } };', '}'],
  ];
  var POOL = [
    ['import { Pool } from "pg";', 'import { config } from "../config";'],
    ['export const pool = new Pool({', '    connectionString: config.databaseUrl,', '    max: 10,', '    idleTimeoutMillis: 30_000/*,*/', '});'],
    ['export const db = {', '    query: (text: string, params: unknown[] = []) => pool.query(text, params)/*,*/', '};'],
  ];
  var SEED = [
    ['import { db } from "../src/server/db/pool";'],
    ['const TEAMS = ["Harbour", "Lantern", "Orchard"];'],
    ['async function main() {', '    for (const name of TEAMS) {', '        await db.query("INSERT INTO teams (name) VALUES ($1) ON CONFLICT DO NOTHING", [name]);', '    }', '    console.log("seeded " + TEAMS.length + " teams");', '}'],
    ['main().then(', '    () => process.exit(0),', '    (e) => {', '        console.error(e);', '        process.exit(1);', '    }/*,*/', ');'],
  ];
  var CSS = [
    ['.team-page {', '    display: grid;', '    gap: 16px;', '    font-family: "Inter", system-ui, sans-serif;', '}'],
    ['.team-page .member-row {', '    display: flex;', '    align-items: center;', '    gap: 12px;', '    padding: 8px 12px;', '}'],
    ['.team-page .invite-banner {', '    background: url("../img/stripes.svg") repeat-x;', '    border-radius: 12px;', '    padding: 12px 16px;', '}'],
  ];
  var ACCESS = [
    ['import type { Member, Team } from "./types";'],
    ['export function isTeamMember(member: Member | null, team: Pick<Team, "id">): boolean {', '    return Boolean(member && member.teamId === team.id);', '}'],
    ['export function canManageTeam(member: Member, team: Pick<Team, "id">): boolean {', '    if (member.teamId !== team.id) return false;', '    if (member.role !== "owner" && member.role !== "admin") return false;', '    return true;', '}'],
    ['export function canViewBilling(member: Member, team: Pick<Team, "id">): boolean {', '    return member.teamId === team.id && member.role === "owner";', '}'],
    ['export function canRemoveMember(actor: Member, target: Member): boolean {', '    if (actor.teamId !== target.teamId) return false;', '    if (target.role === "owner") return false;', '    return actor.role === "owner" || actor.role === "admin";', '}'],
  ];
  // The real change, inside an otherwise-prettier hunk: "owner or admin"
  // becomes "anyone but a viewer", so a plain member can manage the team.
  var ACCESS_CHANGED = {
    2: ['export function canManageTeam(member: Member, team: Pick<Team, \'id\'>): boolean {', '  if (member.teamId !== team.id) return false;', "  if (member.role === 'viewer') return false;", '  return true;', '}'],
  };

  /* ---------------- the real changes ---------------- */

  var MIGRATION = [
    '-- Team invitations: an owner or admin invites someone by email.',
    'CREATE TABLE team_invitations (',
    '  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),',
    '  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,',
    '  email TEXT NOT NULL,',
    "  role TEXT NOT NULL DEFAULT 'member',",
    '  token_hash TEXT NOT NULL,',
    '  invited_by UUID NOT NULL REFERENCES users(id),',
    '  expires_at TIMESTAMPTZ NOT NULL,',
    '  accepted_at TIMESTAMPTZ,',
    '  created_at TIMESTAMPTZ NOT NULL DEFAULT now()',
    ');',
    '',
    'CREATE UNIQUE INDEX team_invitations_token_hash ON team_invitations (token_hash);',
    'CREATE INDEX team_invitations_team_email ON team_invitations (team_id, lower(email));',
    '',
    'ALTER TABLE memberships ADD COLUMN invited_via UUID REFERENCES team_invitations(id);',
  ];
  var ROUTE = [
    "import { Router } from 'express';",
    "import { z } from 'zod';",
    "import { requireUser } from '../middleware/session';",
    "import { canManageTeam } from '../teams/access';",
    "import { getMembership } from '../teams/members';",
    "import { createInvitation, findInvitation, acceptInvitation } from '../teams/invitations';",
    "import { sendInviteEmail } from '../mail/invites';",
    '',
    'export const invitationsRouter = Router();',
    '',
    'const CreateBody = z.object({',
    '  email: z.string().email(),',
    "  level: z.enum(['member', 'viewer']).default('member'),",
    '});',
    '',
    "invitationsRouter.post('/teams/:teamId/invitations', requireUser, async (req, res) => {",
    '  const member = await getMembership(req.user.id, req.params.teamId);',
    '  if (!member || !canManageTeam(member, { id: req.params.teamId })) {',
    "    return res.status(403).json({ error: 'You cannot invite people to this team.' });",
    '  }',
    '  const body = CreateBody.safeParse(req.body);',
    "  if (!body.success) return res.status(400).json({ error: 'Enter a valid email address.' });",
    '  const { invitation, token } = await createInvitation({',
    '    teamId: req.params.teamId,',
    '    email: body.data.email,',
    '    level: body.data.level,',
    '    invitedBy: req.user.id,',
    '  });',
    '  // TODO: rate-limit invitation emails per team',
    '  sendInviteEmail(body.data.email, token).catch(() => {});',
    '  res.status(201).json({ invitation });',
    '});',
    '',
    "invitationsRouter.get('/invitations/:token', async (req, res) => {",
    '  const invitation = await findInvitation(req.params.token);',
    "  if (!invitation) return res.status(404).json({ error: 'This invitation has expired or was already used.' });",
    '  res.json({',
    '    teamName: invitation.teamName,',
    '    inviterName: invitation.inviterName,',
    '    expiresAt: invitation.expiresAt,',
    '  });',
    '});',
    '',
    "invitationsRouter.post('/invitations/:token/accept', requireUser, async (req, res) => {",
    '  const result = await acceptInvitation(req.params.token, req.user);',
    "  if (result.kind === 'expired') return res.status(410).json({ error: 'This invitation has expired.' });",
    "  if (result.kind === 'wrong-email') {",
    "    return res.status(403).json({ error: 'This invitation was sent to a different email address.' });",
    '  }',
    "  if (result.kind === 'missing') return res.status(404).json({ error: 'Invitation not found.' });",
    '  res.json({ teamId: result.teamId });',
    '});',
    '',
    "invitationsRouter.delete('/teams/:teamId/invitations/:id', requireUser, async (req, res) => {",
    '  const member = await getMembership(req.user.id, req.params.teamId);',
    '  if (!member || !canManageTeam(member, { id: req.params.teamId })) {',
    "    return res.status(403).json({ error: 'You cannot change this team.' });",
    '  }',
    "  await req.db.query('UPDATE team_invitations SET expires_at = now() WHERE id = $1 AND team_id = $2', [",
    '    req.params.id,',
    '    req.params.teamId,',
    '  ]);',
    '  res.status(204).end();',
    '});',
  ];
  var SERVICE = [
    "import { createHash, randomBytes } from 'crypto';",
    "import { db } from '../db/pool';",
    "import { config } from '../config';",
    "import { addDays } from '../../web/lib/dates';",
    '',
    'export interface Invitation {',
    '  id: string;',
    '  teamId: string;',
    '  email: string;',
    "  level: 'member' | 'viewer';",
    '  expiresAt: string;',
    '  teamName?: string;',
    '  inviterName?: string;',
    '}',
    '',
    'const hashToken = (token: string) => createHash(\'sha256\').update(token).digest(\'hex\');',
    '',
    'export async function createInvitation(input: {',
    '  teamId: string;',
    '  email: string;',
    "  level: 'member' | 'viewer';",
    '  invitedBy: string;',
    '}) {',
    "  const token = randomBytes(32).toString('base64url');",
    '  const expiresAt = addDays(new Date(), config.inviteTtlDays);',
    '  const { rows } = await db.query(',
    "    'INSERT INTO team_invitations (team_id, email, role, token_hash, invited_by, expires_at) VALUES ($1, lower($2), $3, $4, $5, $6) RETURNING id, team_id, email, role, expires_at',",
    '    [input.teamId, input.email, input.level, hashToken(token), input.invitedBy, expiresAt],',
    '  );',
    '  return { invitation: toInvitation(rows[0]), token };',
    '}',
    '',
    'export async function findInvitation(token: string): Promise<Invitation | null> {',
    '  const { rows } = await db.query(',
    "    'SELECT i.*, t.name AS team_name, u.name AS inviter_name FROM team_invitations i JOIN teams t ON t.id = i.team_id JOIN users u ON u.id = i.invited_by WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.expires_at > now()',",
    '    [hashToken(token)],',
    '  );',
    '  return rows[0] ? toInvitation(rows[0]) : null;',
    '}',
    '',
    'export async function acceptInvitation(token: string, user: { id: string; email: string }) {',
    '  const invitation = await findInvitation(token);',
    "  if (!invitation) return { kind: 'missing' as const };",
    "  if (new Date(invitation.expiresAt) < new Date()) return { kind: 'expired' as const };",
    "  if (invitation.email !== user.email.toLowerCase()) return { kind: 'wrong-email' as const };",
    "  await db.query('BEGIN');",
    '  try {',
    '    await db.query(',
    "      'INSERT INTO memberships (team_id, user_id, role, invited_via) VALUES ($1, $2, $3, $4) ON CONFLICT (team_id, user_id) DO NOTHING',",
    '      [invitation.teamId, user.id, invitation.level, invitation.id],',
    '    );',
    "    await db.query('UPDATE team_invitations SET accepted_at = now() WHERE id = $1', [invitation.id]);",
    "    await db.query('COMMIT');",
    '  } catch (err) {',
    "    await db.query('ROLLBACK');",
    '    throw err;',
    '  }',
    "  return { kind: 'ok' as const, teamId: invitation.teamId };",
    '}',
    '',
    'function toInvitation(row: Record<string, any>): Invitation {',
    '  return {',
    '    id: row.id,',
    '    teamId: row.team_id,',
    '    email: row.email,',
    '    level: row.role,',
    '    expiresAt: new Date(row.expires_at).toISOString(),',
    '    teamName: row.team_name,',
    '    inviterName: row.inviter_name,',
    '  };',
    '}',
  ];
  var SERVICE_TEST = [
    "import { describe, expect, it, beforeEach } from 'vitest';",
    "import { createInvitation, findInvitation, acceptInvitation } from '../../src/server/teams/invitations';",
    "import { resetDb, makeTeam, makeUser } from '../helpers/db';",
    '',
    "describe('team invitations', () => {",
    '  beforeEach(resetDb);',
    '',
    "  it('creates an invitation that can be found by its token', async () => {",
    '    const team = await makeTeam();',
    '    const owner = await makeUser();',
    "    const { token } = await createInvitation({ teamId: team.id, email: 'Sam@Example.test', level: 'member', invitedBy: owner.id });",
    '    const found = await findInvitation(token);',
    "    expect(found?.email).toBe('sam@example.test');",
    '  });',
    '',
    "  it('does not find an invitation by a made-up token', async () => {",
    "    expect(await findInvitation('not-a-real-token')).toBeNull();",
    '  });',
    '',
    "  it('adds the invited person to the team once', async () => {",
    '    const team = await makeTeam();',
    "    const sam = await makeUser({ email: 'sam@example.test' });",
    "    const { token } = await createInvitation({ teamId: team.id, email: sam.email, level: 'viewer', invitedBy: sam.id });",
    '    const first = await acceptInvitation(token, sam);',
    "    expect(first.kind).toBe('ok');",
    '    const again = await acceptInvitation(token, sam);',
    "    expect(again.kind).toBe('missing');",
    '  });',
    '',
    "  it('refuses someone signed in with a different email', async () => {",
    '    const team = await makeTeam();',
    "    const other = await makeUser({ email: 'other@example.test' });",
    "    const { token } = await createInvitation({ teamId: team.id, email: 'sam@example.test', level: 'member', invitedBy: other.id });",
    "    expect((await acceptInvitation(token, other)).kind).toBe('wrong-email');",
    '  });',
    '});',
  ];
  var DIALOG = [
    "import { useState } from 'react';",
    "import { Modal } from '../../../components/Modal';",
    "import { Button } from '../../../components/Button';",
    "import { useInvitations } from '../../../hooks/useInvitations';",
    '',
    'export function InviteDialog({ teamId, open, onClose }: { teamId: string; open: boolean; onClose: () => void }) {',
    "  const [email, setEmail] = useState('');",
    "  const [level, setLevel] = useState<'member' | 'viewer'>('member');",
    '  const [error, setError] = useState<string | null>(null);',
    '  const { invite, inviting } = useInvitations(teamId);',
    '',
    '  async function submit(e: React.FormEvent) {',
    '    e.preventDefault();',
    '    setError(null);',
    '    const result = await invite(email.trim(), level);',
    '    if (result.error) {',
    '      setError(result.error);',
    '      return;',
    '    }',
    "    setEmail('');",
    '    onClose();',
    '  }',
    '',
    '  return (',
    '    <Modal title="Invite someone" open={open} onClose={onClose}>',
    '      <form onSubmit={submit} className="invite-form">',
    '        <label>',
    '          Email',
    '          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />',
    '        </label>',
    '        <fieldset>',
    '          <legend>They can</legend>',
    '          <label>',
    '            <input type="radio" checked={level === \'member\'} onChange={() => setLevel(\'member\')} />',
    '            Edit the team’s projects',
    '          </label>',
    '          <label>',
    '            <input type="radio" checked={level === \'viewer\'} onChange={() => setLevel(\'viewer\')} />',
    '            Only view',
    '          </label>',
    '        </fieldset>',
    '        {error && <p className="error">{error}</p>}',
    '        <Button type="submit" busy={inviting}>',
    '          Send invitation',
    '        </Button>',
    '      </form>',
    '    </Modal>',
    '  );',
    '}',
  ];
  var HOOK = [
    "import { useState } from 'react';",
    "import { api } from '../client';",
    '',
    'export function useInvitations(teamId: string) {',
    '  const [inviting, setInviting] = useState(false);',
    '',
    "  async function invite(email: string, level: 'member' | 'viewer') {",
    '    setInviting(true);',
    '    try {',
    '      const res = await api.createInvitation({ teamId }, { email, level });',
    '      if (!res.ok) return { error: res.error.error };',
    '      return { error: null };',
    '    } finally {',
    '      setInviting(false);',
    '    }',
    '  }',
    '',
    '  return { invite, inviting };',
    '}',
  ];
  var DOCS = [
    '# Team invitations',
    '',
    'Owners and admins can invite people to a team by email.',
    '',
    '1. Open the team page and choose **Invite someone**.',
    '2. Enter their email and choose whether they can edit or only view.',
    '3. They get an email with a link. The link works once and expires after',
    '   the number of days in `INVITE_TTL_DAYS`.',
    '',
    'An invitation can only be accepted by someone signed in with the same',
    'email address it was sent to.',
    '',
    '## Revoking',
    '',
    'An unused invitation can be revoked from the team page; the link stops',
    'working at once.',
  ];

  function build() {
    out = []; stat = []; seed = 20261013;

    // Alphabetical, the way git prints them - so the one real permission
    // change sits in the middle of a long run of reformatted files.
    mod('.env.example', [hunk(6, 6, [[' ', 'DATABASE_URL=postgres://localhost:5432/crewdeck'], [' ', 'MAIL_FROM=Crewdeck <hello@crewdeck.example>'], ['-', 'INVITE_TTL_DAYS=7'], ['+', 'INVITE_TTL_DAYS=30'], ['+', 'FEATURE_INVITES=on']])]);
    mod('CHANGELOG.md', [hunk(1, 1, [[' ', '# Changelog'], [' ', ''], ['+', '## Unreleased'], ['+', ''], ['+', '- Team owners and admins can invite people by email.'], ['+', '- Team components moved to `src/web/features/team`.'], ['+', '- Code style: prettier with single quotes and trailing commas.'], ['+', ''], [' ', '## 2.3.0 - 2026-09-30']])]);
    add('db/migrations/0018_team_invitations.sql', MIGRATION);
    add('docs/invitations.md', DOCS);
    mod('package.json', [hunk(21, 21, [[' ', '    "express": "^4.21.1",'], [' ', '    "kysely": "^0.27.4",'], ['+', '    "nanoid": "^5.0.7",'], [' ', '    "pg": "^8.13.0",'], [' ', '    "zod": "^3.23.8"']])]);
    lockfile();
    reformat('scripts/seed.ts', SEED);
    reformat('src/server/config.ts', [['export const config = {', '    databaseUrl: process.env.DATABASE_URL ?? "postgres://localhost:5432/crewdeck",', '    mailFrom: process.env.MAIL_FROM ?? "Crewdeck <hello@crewdeck.example>",', '    inviteTtlDays: Number(process.env.INVITE_TTL_DAYS || 7),', '};']], {
      0: ['export const config = {', "  databaseUrl: process.env.DATABASE_URL ?? 'postgres://localhost:5432/crewdeck',", "  mailFrom: process.env.MAIL_FROM ?? 'Crewdeck <hello@crewdeck.example>',", '  inviteTtlDays: Number(process.env.INVITE_TTL_DAYS || 30),', "  invitesEnabled: process.env.FEATURE_INVITES !== 'off',", '};'],
    });
    reformat('src/server/db/pool.ts', POOL);
    mod('src/server/jobs/digest.ts', [
      hunk(2, 2, [[' ', "import { sendDigest } from '../mail/digest';"], ['-', "import { getTeamMembers } from '../teams/members';"], ['+', "import { listTeamMembers } from '../teams/members';"], [' ', "import { listActiveTeams } from '../teams/teams';"]]),
      hunk(14, 14, [[' ', '  for (const team of await listActiveTeams()) {'], ['-', '    const members = await getTeamMembers(team.id);'], ['+', '    const members = await listTeamMembers(team.id);'], [' ', '    await sendDigest(team, members);']]),
    ]);
    reformat('src/server/lib/errors.ts', ERRORS);
    reformat('src/server/lib/logger.ts', LOGGER);
    add('src/server/routes/invitations.ts', ROUTE);
    mod('src/server/routes/teams.ts', [
      hunk(4, 4, [[' ', "import { requireUser } from '../middleware/session';"], ['-', "import { getTeamMembers } from '../teams/members';"], ['+', "import { listTeamMembers } from '../teams/members';"], [' ', "import { getTeam } from '../teams/teams';"]]),
      hunk(31, 31, [[' ', "teamsRouter.get('/teams/:teamId/members', requireUser, async (req, res) => {"], ['-', '  const members = await getTeamMembers(req.params.teamId);'], ['+', '  const members = await listTeamMembers(req.params.teamId);'], [' ', '  res.json({ members });']]),
    ]);
    reformat('src/server/teams/access.ts', ACCESS, ACCESS_CHANGED);
    mod('src/server/teams/export.ts', [
      hunk(1, 1, [[' ', "import { toCsv } from '../lib/csv';"], ['-', "import { getTeamMembers } from './members';"], ['+', "import { listTeamMembers } from './members';"], [' ', '']]),
      hunk(9, 9, [[' ', 'export async function exportTeam(teamId: string) {'], ['-', '  const rows = (await getTeamMembers(teamId)).map((m) => [m.name, m.email, m.joinedAt]);'], ['+', '  const rows = (await listTeamMembers(teamId)).map((m) => [m.name, m.email, m.joinedAt]);'], [' ', "  return toCsv(['Name', 'Email', 'Joined'], rows);"]]),
    ]);
    mod('src/server/teams/index.ts', [hunk(1, 1, [[' ', "export * from './teams';"], ['-', "export { getTeamMembers, getMembership } from './members';"], ['+', "export { listTeamMembers, getMembership } from './members';"], [' ', "export * from './access';"]])]);
    add('src/server/teams/invitations.ts', SERVICE);
    mod('src/server/teams/members.ts', [hunk(8, 8, [[' ', ''], ['-', 'export async function getTeamMembers(teamId: string): Promise<MemberSummary[]> {'], ['+', 'export async function listTeamMembers(teamId: string): Promise<MemberSummary[]> {'], [' ', '  const { rows } = await db.query(']])]);
    mod('src/web/App.tsx', [hunk(3, 3, [[' ', "import { TeamPage } from './pages/TeamPage';"], ['-', "import { TeamSettings } from './components/team/TeamSettings';"], ['+', "import { TeamSettings } from './features/team/components/TeamSettings';"], [' ', "import { SettingsPage } from './pages/SettingsPage';"]])]);
    generatedClient();
    snapshot('src/web/components/__snapshots__/Avatar.test.tsx.snap', 'Avatar', 6);
    snapshot('src/web/components/__snapshots__/Button.test.tsx.snap', 'Button', 9);
    snapshot('src/web/components/__snapshots__/Modal.test.tsx.snap', 'Modal', 7);
    snapshot('src/web/components/__snapshots__/Toast.test.tsx.snap', 'Toast', 6);
    reformat('src/web/components/Button.tsx', BUTTON);
    reformat('src/web/components/Modal.tsx', MODAL);
    ['MemberList.tsx', 'MemberRow.tsx', 'RoleBadge.tsx', 'TeamHeader.tsx', 'TeamSettings.tsx', 'index.ts'].forEach(function (f) {
      rename('src/web/components/team/' + f, 'src/web/features/team/components/' + f);
    });
    add('src/web/features/team/components/InviteDialog.tsx', DIALOG);
    add('src/web/hooks/useInvitations.ts', HOOK);
    reformat('src/web/lib/dates.ts', DATES);
    reformat('src/web/lib/format.ts', FORMAT);
    mod('src/web/main.tsx', [hunk(1, 1, [['-', "import React from 'react';"], ['-', "import { createRoot } from 'react-dom/client';"], ['-', "import { App } from './App';"], ['-', "import './styles/base.css';"], ['+', "import './styles/base.css';"], ['+', "import { App } from './App';"], ['+', "import React from 'react';"], ['+', "import { createRoot } from 'react-dom/client';"], [' ', '']])]);
    mod('src/web/pages/SettingsPage.tsx', [hunk(2, 2, [[' ', "import { useTeam } from '../hooks/useTeam';"], ['-', "import { RoleBadge } from '../components/team/RoleBadge';"], ['+', "import { RoleBadge } from '../features/team/components/RoleBadge';"], [' ', "import { Button } from '../components/Button';"]])]);
    mod('src/web/pages/TeamPage.tsx', [hunk(1, 1, [[' ', "import { useParams } from 'react-router-dom';"], ['-', "import { MemberList } from '../components/team/MemberList';"], ['-', "import { TeamHeader } from '../components/team';"], ['+', "import { MemberList } from '../features/team/components/MemberList';"], ['+', "import { TeamHeader } from '../features/team/components';"], [' ', "import { useTeam } from '../hooks/useTeam';"]])]);
    reformat('src/web/styles/team.css', CSS);
    mod('test/teams/members.test.ts', [
      hunk(2, 2, [[' ', "import { resetDb, makeTeam, makeUser } from '../helpers/db';"], ['-', "import { getTeamMembers } from '../../src/server/teams/members';"], ['+', "import { listTeamMembers } from '../../src/server/teams/members';"], [' ', '']]),
      hunk(12, 12, [[' ', '    await makeUser({ teamId: team.id });'], ['-', '    const members = await getTeamMembers(team.id);'], ['+', '    const members = await listTeamMembers(team.id);'], [' ', '    expect(members).toHaveLength(2);']]),
    ]);
    add('test/teams/invitations.test.ts', SERVICE_TEST);

    var adds = 0, dels = 0;
    var head = stat.map(function (s) { adds += s[1][0]; dels += s[1][1]; var n = s[1][0] + s[1][1]; return ' ' + s[0] + ' | ' + n + (n ? ' ' + new Array(Math.min(40, Math.ceil(n / 20)) + 1).join('+') : ''); });
    head.push(' ' + stat.length + ' files changed, ' + adds + ' insertions(+), ' + dels + ' deletions(-)');
    return head.join('\n') + '\n' + out.join('\n') + '\n';
  }

  var cached = null;
  return {
    title: 'Add team invitations',
    branch: 'agent/team-invitations',
    base: 'main',
    author: 'an AI coding agent',
    text: function () { if (cached === null) cached = build(); return cached; },
    // What the tests hold the example to (and the CLAUDE.md describes).
    planted: {
      first: 'src/server/teams/access.ts',
      high: ['src/server/teams/access.ts', 'src/server/routes/invitations.ts', 'src/server/teams/invitations.ts', 'db/migrations/0018_team_invitations.sql'],
      medium: ['.env.example', 'package.json', 'src/server/config.ts'],
      low: ['docs/invitations.md', 'src/web/features/team/components/InviteDialog.tsx', 'src/web/hooks/useInvitations.ts', 'test/teams/invitations.test.ts'],
      rename: { from: 'getTeamMembers', to: 'listTeamMembers' },
      moved: { from: 'src/web/components/team', to: 'src/web/features/team/components' },
    },
  };
}));
