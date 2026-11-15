import type { BookingStatus, ListingStatus } from '../shared/db';
import { fmtMoney } from '../shared/format';
import { type HtmlValue, type SafeHtml, html } from '../shared/html';
import { htmlResponse, redirect } from '../shared/http';
import type { AdminCtx } from './context';

export const ADMIN_CSS = `
:root{--navy:#0b1f3a;--ink:#14213d;--muted:#5b6678;--line:#d9dee7;--bg:#f5f6f8;--card:#fff;--lime:#c6f24e;--focus:#1d4ed8;
--ok:#14532d;--okbg:#dcfce7;--warn:#713f12;--warnbg:#fef3c7;--bad:#7f1d1d;--badbg:#fee2e2;--idle:#334155;--idlebg:#e2e8f0;color-scheme:light}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:var(--ink);background:var(--bg)}
a{color:#1f4580}:focus-visible{outline:3px solid var(--focus);outline-offset:2px;border-radius:4px}
header{background:var(--navy);color:#fff}header .in{max-width:1200px;margin:0 auto;padding:10px 16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;justify-content:space-between}
header a{color:#fff;text-decoration:none;font-weight:600;padding:6px 8px;border-radius:6px}header a:hover{background:#18335c}
header .brand{font-weight:800}header .brand span{color:var(--lime)}header nav{display:flex;gap:4px;flex-wrap:wrap}
.who{font-size:.85rem;color:#c9d4e6}main{max-width:1200px;margin:0 auto;padding:20px 16px 60px}
h1{font-size:1.6rem;margin:0 0 12px}h2{font-size:1.2rem;margin:0 0 10px}h3{font-size:1.05rem;margin:14px 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:0 0 16px}
.grid{display:grid;gap:16px}@media(min-width:960px){.grid.two{grid-template-columns:1fr 1fr}}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:.93rem}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:.8rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted)}
.badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:.8rem;font-weight:700;white-space:nowrap}
.b-ok{background:var(--okbg);color:var(--ok)}.b-warn{background:var(--warnbg);color:var(--warn)}.b-bad{background:var(--badbg);color:var(--bad)}.b-idle{background:var(--idlebg);color:var(--idle)}.b-lime{background:var(--lime);color:var(--navy)}
form.inline{display:inline}button,.btn{font:inherit;font-weight:700;border-radius:8px;border:2px solid var(--navy);background:#fff;color:var(--navy);padding:7px 12px;min-height:40px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px}
button.primary,.btn.primary{background:var(--navy);color:#fff}button.danger{border-color:#b91c1c;color:#b91c1c}button.small,.btn.small{padding:3px 8px;min-height:32px;font-size:.85rem}
label{display:block;font-weight:700;margin:0 0 4px}.hint{font-weight:400;color:var(--muted);font-size:.88rem}
input[type=text],input[type=email],input[type=url],input[type=number],input[type=date],input[type=time],select,textarea{width:100%;font:inherit;padding:8px 10px;border:2px solid #9aa4b5;border-radius:8px;background:#fff;min-height:42px}
textarea{min-height:120px}textarea.tall{min-height:260px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.9rem}
.row{display:grid;gap:12px}@media(min-width:720px){.row.c2{grid-template-columns:1fr 1fr}.row.c3{grid-template-columns:1fr 1fr 1fr}.row.c4{grid-template-columns:repeat(4,1fr)}}
.f{margin:0 0 12px}.actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:10px 0}
.flash{background:var(--okbg);color:var(--ok);border:1px solid #86efac;border-radius:10px;padding:10px 12px;margin:0 0 16px}
.flash.err{background:var(--badbg);color:var(--bad);border-color:#fca5a5}.warnbox{background:var(--warnbg);color:var(--warn);border:1px solid #fcd34d;border-radius:10px;padding:10px 12px;margin:0 0 16px}
.muted{color:var(--muted)}.small{font-size:.88rem}code,.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.88rem;word-break:break-all}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px}.kv dt{color:var(--muted)}.kv dd{margin:0}
.copy{display:flex;gap:6px}.copy input{flex:1}.stat{font-size:1.6rem;font-weight:800}
.pill-live{background:var(--okbg);color:var(--ok)}.pill-paused{background:var(--badbg);color:var(--bad)}
`;

export const ADMIN_JS = `(function(){"use strict";
document.querySelectorAll("form[data-confirm]").forEach(function(f){f.addEventListener("submit",function(e){if(!confirm(f.getAttribute("data-confirm"))){e.preventDefault();}});});
document.querySelectorAll("[data-copy]").forEach(function(b){b.hidden=false;b.addEventListener("click",function(){var t=document.getElementById(b.getAttribute("data-copy"));if(!t)return;var v=t.value||t.textContent||"";if(navigator.clipboard){navigator.clipboard.writeText(v).then(function(){var o=b.textContent;b.textContent="Copied";setTimeout(function(){b.textContent=o;},1500);});}else{t.select();document.execCommand("copy");}});});
var ed=document.querySelector("[data-mail-editor]");
if(ed){var s=ed.querySelector("[name=subject]"),bd=ed.querySelector("[name=body]"),to=ed.getAttribute("data-to")||"",bcc=ed.getAttribute("data-bcc")||"";
function upd(){var q=[];if(bcc)q.push("bcc="+encodeURIComponent(bcc));q.push("subject="+encodeURIComponent(s.value));q.push("body="+encodeURIComponent(bd.value));
var m=ed.querySelector("[data-mailto]");if(m)m.href="mailto:"+encodeURIComponent(to).replace(/%40/g,"@").replace(/%2C/g,",")+"?"+q.join("&");
var g=ed.querySelector("[data-gmail]");if(g)g.href="https://mail.google.com/mail/?view=cm&fs=1&to="+encodeURIComponent(to)+"&bcc="+encodeURIComponent(bcc)+"&su="+encodeURIComponent(s.value)+"&body="+encodeURIComponent(bd.value);
var hs=ed.querySelector("[name=subject_sent]");if(hs)hs.value=s.value;}
s.addEventListener("input",upd);bd.addEventListener("input",upd);}
})();`;

export function csrfField(ctx: AdminCtx): SafeHtml {
  return html`<input type="hidden" name="csrf" value="${ctx.csrf}">`;
}

export function postButton(
  ctx: AdminCtx,
  action: string,
  label: string,
  opts: { confirm?: string; cls?: string; fields?: Record<string, string> } = {},
): SafeHtml {
  return html`<form class="inline" method="post" action="${action}" ${opts.confirm ? html`data-confirm="${opts.confirm}"` : ''}>
    ${csrfField(ctx)}${Object.entries(opts.fields ?? {}).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
    <button type="submit" class="${opts.cls ?? 'small'}">${label}</button></form>`;
}

export function table(headers: string[], rows: HtmlValue[][], empty = 'Nothing here yet.'): SafeHtml {
  if (rows.length === 0) return html`<p class="muted">${empty}</p>`;
  return html`<div class="scroll"><table><thead><tr>${headers.map((h) => html`<th scope="col">${h}</th>`)}</tr></thead>
    <tbody>${rows.map((r) => html`<tr>${r.map((c) => html`<td>${c}</td>`)}</tr>`)}</tbody></table></div>`;
}

export function bookingBadge(status: BookingStatus): SafeHtml {
  const map: Record<BookingStatus, [string, string]> = {
    confirmed: ['b-ok', 'Confirmed'],
    pending: ['b-warn', 'Checkout open'],
    hold: ['b-warn', 'Held · creating checkout'],
    exception: ['b-bad', 'Needs review'],
    expired: ['b-idle', 'Expired unpaid'],
    failed: ['b-idle', 'Checkout failed'],
    cancelled: ['b-idle', 'Cancelled'],
  };
  const [cls, text] = map[status];
  return html`<span class="badge ${cls}">${text}</span>`;
}

export function listingBadge(status: ListingStatus): SafeHtml {
  const map: Record<ListingStatus, [string, string]> = {
    draft: ['b-idle', 'Draft'],
    published: ['b-ok', 'Published'],
    closed: ['b-warn', 'Closed'],
    cancelled: ['b-bad', 'Cancelled'],
  };
  const [cls, text] = map[status];
  return html`<span class="badge ${cls}">${text}</span>`;
}

export function money(pence: number | null | undefined): string {
  return pence === null || pence === undefined ? '—' : fmtMoney(pence);
}

export function flashFromUrl(ctx: AdminCtx): SafeHtml {
  const ok = ctx.url.searchParams.get('ok');
  const err = ctx.url.searchParams.get('err');
  return html`${ok ? html`<div class="flash" role="status">${ok.slice(0, 400)}</div>` : ''}${err ? html`<div class="flash err" role="alert">${err.slice(0, 600)}</div>` : ''}`;
}

export function back(path: string, msg: { ok?: string; err?: string }): Response {
  const qs = new URLSearchParams();
  if (msg.ok) qs.set('ok', msg.ok);
  if (msg.err) qs.set('err', msg.err);
  return redirect(`${path}${path.includes('?') ? '&' : '?'}${qs.toString()}`, { private: true });
}

export function stripeDashboardUrl(ctx: AdminCtx, kind: 'payments' | 'checkout', id: string): string {
  const base = ctx.cfg.stripe.livemode ? 'https://dashboard.stripe.com' : 'https://dashboard.stripe.com/test';
  return kind === 'payments' ? `${base}/payments/${id}` : `${base}/checkout/sessions/${id}`;
}

export function adminLayout(ctx: AdminCtx, opts: { title: string; body: SafeHtml; status?: number }): Response {
  const page = html`<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${opts.title} · Tutor dashboard</title><meta name="robots" content="noindex, nofollow">
<link rel="stylesheet" href="/assets/admin.css"><script src="/assets/admin.js" defer></script></head>
<body><header><div class="in"><a class="brand" href="/">Tutor <span>dashboard</span></a>
<nav aria-label="Dashboard"><a href="/">Overview</a><a href="/listings/new">New listing</a><a href="/waitlist">Waitlist</a><a href="/stats">Stats</a><a href="/issues">Payment issues</a><a href="/settings">Settings</a><a href="/audit">Audit log</a></nav>
<span class="who">${ctx.email}${ctx.via === 'dev' ? ' (local dev identity)' : ''}</span></div></header>
<main id="main">${flashFromUrl(ctx)}${opts.body}</main></body></html>`;
  return htmlResponse(page, { status: opts.status ?? 200, private: true });
}
