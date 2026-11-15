/** Public stylesheet. Served from /assets/app.css with a content hash; no inline styles (strict CSP). */
export const PUBLIC_CSS = `
:root{
  --navy:#0b1f3a;--navy-2:#132c52;--navy-3:#1f4580;--paper:#fbf8f1;--paper-2:#f2ecdf;--card:#fff;
  --ink:#0b1f3a;--muted:#46546b;--line:#d8d0bf;--lime:#c6f24e;--lime-2:#b2e035;--focus:#1d4ed8;
  --ok-bg:#dff5e5;--ok-ink:#14532d;--warn-bg:#fdf0d2;--warn-ink:#6b4100;--bad-bg:#fde3df;--bad-ink:#7f1d1d;
  --idle-bg:#e7eaf0;--idle-ink:#334155;--radius:14px;
  --font:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;
  color-scheme:light;
}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;font-family:var(--font);font-size:1.0625rem;line-height:1.55;color:var(--ink);background:var(--paper)}
img,svg{max-width:100%}
a{color:var(--navy-3);text-underline-offset:3px}
a:hover{color:var(--navy)}
:focus-visible{outline:3px solid var(--focus);outline-offset:3px;border-radius:6px}
.on-dark :focus-visible,.on-dark:focus-visible{outline-color:var(--lime)}
.skip{position:absolute;left:-9999px;top:0}
.skip:focus{left:16px;top:12px;z-index:200;background:#fff;color:var(--navy);padding:10px 14px;border-radius:8px}
.visually-hidden{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.wrap{max-width:1120px;margin:0 auto;padding:0 16px}
.narrow{max-width:720px}
header.site{background:var(--navy);color:#fff}
header.site .wrap{display:flex;align-items:center;justify-content:space-between;min-height:60px;gap:12px;flex-wrap:wrap}
.brand{color:#fff;text-decoration:none;font-weight:800;letter-spacing:-.01em;font-size:1.1rem;padding:6px 0}
.brand span{color:var(--lime)}
.site-nav{display:flex;gap:6px;flex-wrap:wrap}
.site-nav a{color:#fff;text-decoration:none;font-weight:600;padding:10px 10px;border-radius:8px}
.site-nav a:hover{background:var(--navy-2);color:#fff}
.hero{background:var(--navy);color:#fff;padding:20px 0 36px}
.hero-grid{display:grid;gap:22px}
@media (min-width:900px){
  .hero{padding:56px 0 64px}
  .hero-grid{grid-template-columns:1.1fr 1fr;gap:48px;align-items:start}
}
h1{font-size:clamp(2rem,7vw,3.3rem);line-height:1.06;letter-spacing:-.025em;margin:0 0 14px}
h2{font-size:1.55rem;line-height:1.2;letter-spacing:-.01em;margin:0 0 12px}
h3{font-size:1.2rem;margin:0 0 8px}
.lede{font-size:1.15rem;color:#dfe7f5;margin:0 0 6px;max-width:36rem}
.hero .eyebrow{display:inline-block;background:var(--navy-2);color:var(--lime);font-weight:700;font-size:.9rem;padding:5px 12px;border-radius:999px;margin-bottom:14px}
.card{background:var(--card);color:var(--ink);border-radius:var(--radius);padding:20px;box-shadow:0 12px 32px rgba(11,31,58,.18)}
.card.flat{box-shadow:none;border:1px solid var(--line)}
.card-soldout{border-top:6px solid #e59a90}.card-cancelled{border-top:6px solid #9aa6b8}
.booking-card .topic{text-transform:uppercase;font-size:.8rem;letter-spacing:.08em;font-weight:800;color:var(--muted);margin:0}
.booking-card h2{font-size:1.35rem;margin:4px 0 10px}
.facts{list-style:none;padding:0;margin:0 0 14px;display:grid;gap:6px}
.facts li{display:flex;gap:10px;align-items:baseline}
.facts .k{min-width:4.6rem;color:var(--muted);font-weight:600;font-size:.95rem}
.date-list{list-style:none;padding:0;margin:0 0 14px;display:grid;gap:6px}
.date-list li{padding:8px 12px;background:var(--paper);border-radius:10px;border:1px solid var(--line)}
.date-list .when{font-weight:700}
.date-list .seq{color:var(--muted);font-size:.9rem}
.price-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:4px 0 14px;flex-wrap:wrap}
.price{font-size:1.9rem;font-weight:800;letter-spacing:-.02em}
.price small{font-size:1rem;font-weight:600;color:var(--muted)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:52px;padding:12px 22px;border-radius:12px;font:inherit;font-weight:800;font-size:1.05rem;line-height:1.2;text-decoration:none;border:2px solid transparent;cursor:pointer;text-align:center}
.btn-primary{background:var(--lime);color:var(--navy);border-color:var(--lime)}
.btn-primary:hover{background:var(--lime-2);border-color:var(--lime-2);color:var(--navy)}
.btn-secondary{background:#fff;color:var(--navy);border-color:var(--navy)}
.btn-secondary:hover{background:var(--paper-2)}
.btn-quiet{background:transparent;color:var(--navy-3);border-color:transparent;text-decoration:underline;min-height:44px;padding:8px 10px}
.btn-block{width:100%}
.btn[disabled]{opacity:.65;cursor:progress}
.cta-note{font-size:.95rem;color:var(--muted);margin:10px 0 0}
.badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:.85rem;font-weight:800;vertical-align:middle}
.badge-ok{background:var(--ok-bg);color:var(--ok-ink)}
.badge-warn{background:var(--warn-bg);color:var(--warn-ink)}
.badge-bad{background:var(--bad-bg);color:var(--bad-ink)}
.badge-idle{background:var(--idle-bg);color:var(--idle-ink)}
.badge-lime{background:var(--lime);color:var(--navy)}
.state{border-radius:var(--radius);padding:16px 18px;margin:0 0 18px;border:2px solid}
.state h2,.state h1{margin-top:0}
.state p:last-child{margin-bottom:0}
.state-confirmed{background:var(--ok-bg);border-color:#7bc493;color:var(--ok-ink)}
.state-pending{background:var(--warn-bg);border-color:#e0b75c;color:var(--warn-ink)}
.state-soldout{background:var(--bad-bg);border-color:#e59a90;color:var(--bad-ink)}
.state-cancelled{background:var(--idle-bg);border-color:#9aa6b8;color:var(--idle-ink)}
.state-empty{background:#fff;border-color:var(--line);border-style:dashed;color:var(--ink)}
.section{padding:40px 0}
.section.alt{background:var(--paper-2)}
.section-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:12px}
.steps{display:grid;gap:14px;counter-reset:step;margin:0 0 20px;padding:0;list-style:none}
@media (min-width:720px){.steps{grid-template-columns:repeat(3,1fr)}}
.steps li{background:#fff;border:1px solid var(--line);border-radius:var(--radius);padding:16px}
.steps li::before{counter-increment:step;content:counter(step);display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;background:var(--navy);color:var(--lime);font-weight:800;margin-bottom:8px}
.steps strong{display:block;font-size:1.1rem}
.two-col{display:grid;gap:20px}
.hero-grid>*,.two-col>*,.steps>li{min-width:0}
@media (min-width:900px){.two-col{grid-template-columns:1fr 1fr;align-items:start}}
.code-card{background:#0e223f;color:#e9eefa;border-radius:var(--radius);padding:16px 18px;font-family:var(--mono);font-size:.95rem;line-height:1.6;overflow-x:auto;margin:0}
.code-card .c{color:#9fb3d4}.code-card .k{color:var(--lime)}.code-card .n{color:#ffd27a}
.question{font-weight:700;margin:0 0 10px}
.upcoming{list-style:none;padding:0;margin:0;display:grid;gap:12px}
@media (min-width:720px){.upcoming{grid-template-columns:repeat(2,1fr)}}
.upcoming li{background:#fff;border:1px solid var(--line);border-radius:var(--radius);padding:16px;display:flex;flex-direction:column;gap:6px}
.upcoming .meta{color:var(--muted);font-size:.95rem}
.upcoming a.title{font-weight:800;font-size:1.1rem;text-decoration:none}
.upcoming a.title:hover{text-decoration:underline}
details{background:#fff;border:1px solid var(--line);border-radius:12px;padding:0;margin:0 0 10px}
summary{cursor:pointer;font-weight:700;padding:14px 16px;min-height:48px;list-style-position:inside}
details>div{padding:0 16px 14px}
.agenda-nav{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 18px}
.agenda-day{margin:0 0 16px}
.agenda-day h2{font-size:1.1rem;margin:0 0 8px;padding-bottom:4px;border-bottom:2px solid var(--line)}
.agenda-day.today h2{border-color:var(--navy)}
.agenda-empty{color:var(--muted);margin:0 0 8px;font-size:.95rem}
.agenda-item{display:grid;gap:4px;background:#fff;border:1px solid var(--line);border-left:6px solid var(--navy-3);border-radius:12px;padding:12px 14px;margin:0 0 8px}
.agenda-item.pkg{border-left-color:var(--lime-2)}
.agenda-item .time{font-weight:800}
.agenda-item .pkg-label{font-size:.9rem;color:var(--muted)}
.agenda-item a{font-weight:700}
form .field{margin:0 0 16px}
label,.label{display:block;font-weight:700;margin:0 0 6px}
.hint{display:block;font-weight:400;color:var(--muted);font-size:.95rem;margin-top:2px}
input[type=text],input[type=email],input[type=url],input[type=number],input[type=date],input[type=time],textarea,select{width:100%;font:inherit;color:var(--ink);padding:12px 14px;border:2px solid #7c8799;border-radius:10px;background:#fff;min-height:50px}
textarea{min-height:110px}
input:focus-visible,textarea:focus-visible,select:focus-visible{border-color:var(--focus)}
input[aria-invalid=true]{border-color:var(--bad-ink)}
.check{display:flex;gap:12px;align-items:flex-start;margin:0 0 12px;font-weight:400}
.check input{width:24px;height:24px;margin:2px 0 0;flex:none;accent-color:var(--navy)}
fieldset{border:2px solid var(--line);border-radius:12px;padding:14px 16px;margin:0 0 16px}
legend{font-weight:800;padding:0 6px}
.days{display:flex;flex-wrap:wrap;gap:8px}
.days label{display:flex;gap:6px;align-items:center;border:2px solid var(--line);border-radius:10px;padding:8px 12px;font-weight:600;min-height:44px}
.days input{width:20px;height:20px}
.error-box{background:var(--bad-bg);color:var(--bad-ink);border:2px solid #e59a90;padding:12px 14px;border-radius:12px;margin:0 0 16px}
.error-box ul{margin:6px 0 0;padding-left:20px}
.field-error{color:var(--bad-ink);font-weight:700;font-size:.95rem;margin:6px 0 0}
.notice{background:#fff;border:2px solid var(--line);border-radius:12px;padding:12px 14px;margin:0 0 16px}
.welcome{background:var(--lime);color:var(--navy);padding:10px 0;font-weight:700}
.welcome a{color:var(--navy)}
.summary-box{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:0 0 16px}
.summary-box h2{font-size:1.15rem}
.seller{font-size:.95rem;color:var(--muted)}
.policy{background:#fff;border:1px solid var(--line);border-radius:12px;padding:14px 16px;font-size:.98rem}
.policy h2{font-size:1.1rem;margin-top:14px}
.legal h2{font-size:1.25rem;margin-top:26px}
.page{padding:28px 0 48px}
.page h1{font-size:clamp(1.8rem,6vw,2.5rem)}
.meeting{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:6px}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin:12px 0}
.copy-row{display:flex;gap:8px;flex-wrap:wrap}
.copy-row input{flex:1 1 220px}
footer.site{background:var(--navy);color:#d4ddec;padding:32px 0 110px;margin-top:24px}
footer.site a{color:#fff}
footer.site .wrap{display:grid;gap:14px}
@media (min-width:900px){footer.site{padding-bottom:40px}footer.site .wrap{grid-template-columns:2fr 1fr}}
.foot-label{font-weight:800;color:#fff}
.foot-links{display:flex;gap:6px 16px;flex-wrap:wrap;list-style:none;padding:0;margin:0}
.foot-links a{display:inline-block;padding:6px 0}
.sticky-cta{position:fixed;left:0;right:0;bottom:0;z-index:80;background:rgba(11,31,58,.98);color:#fff;padding:10px 16px calc(10px + env(safe-area-inset-bottom));display:flex;gap:12px;align-items:center;justify-content:space-between;box-shadow:0 -6px 20px rgba(0,0,0,.2)}
.sticky-cta[hidden]{display:none}
.sticky-cta .sc-text{font-size:.95rem;line-height:1.3}
.sticky-cta .btn{min-height:48px;padding:10px 16px;white-space:nowrap}
@media (min-width:900px){.sticky-cta{display:none!important}}
.muted{color:var(--muted)}
.small{font-size:.95rem}
.mt0{margin-top:0}.mb0{margin-bottom:0}
@media (prefers-reduced-motion:no-preference){.btn{transition:background-color .15s ease}}
@media print{.sticky-cta,header.site nav,footer.site{display:none}}
`;
