import { createHash } from 'node:crypto';

/**
 * The sign-in page (network exposure spec, 7.6): inline, no assets, served with status 401.
 *
 * It is the first thing a phone sees, so it is a splash, not a bare form: the Dispatch mark, one
 * sentence, and two ways in. The main way is a sign-in code from Settings → Access on a device
 * that is signed in, either scanned as a QR link (`#code=`) or typed; the other is the long
 * access token from `dispatch access`. The form is folded away behind "Enter a code" so the
 * page reads as one step. A `#code=` or `#access=` link signs in on load and shows "Signing in".
 *
 * Everything is inline because the page's CSP allows no asset loads (signInPageCsp): the mark is
 * an inline SVG, the font is the system font, and the script is allowed by hash.
 */
export function signInPage(basePath: string): string {
  const base = JSON.stringify(basePath).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#0f0f12">
<title>Dispatch: sign in</title>
<style>
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:#e8e8ea;background:#0f0f12;display:flex;align-items:center;justify-content:center;padding:max(1rem,env(safe-area-inset-top)) 1rem max(1rem,env(safe-area-inset-bottom))}
.card{width:100%;max-width:23rem;background:#16161a;border:1px solid #2c2c32;border-radius:18px;padding:2rem 1.5rem 1.5rem;box-shadow:0 20px 60px rgba(0,0,0,.45)}
.mark{display:flex;align-items:center;gap:.8rem;margin-bottom:1.4rem}
.mark svg{width:52px;height:52px;flex:none}
.mark h1{margin:0;font-size:1.5rem;font-weight:700;letter-spacing:-.01em}
.mark small{display:block;font-size:.8rem;font-weight:500;letter-spacing:.12em;text-transform:uppercase;color:#8d8d96}
p{margin:0 0 1rem;color:#b5b5bd;font-size:.95rem}
b{color:#e8e8ea;font-weight:600}
ol{margin:0 0 1.2rem;padding-left:1.2rem;color:#b5b5bd;font-size:.95rem}
ol li{margin:.35rem 0}
ol li::marker{color:#3ecf6a;font-weight:600}
code{font:.85em ui-monospace,SFMono-Regular,Menlo,monospace;background:#232329;padding:.1rem .35rem;border-radius:5px;color:#d7d7dd}
button,input{font:inherit;width:100%}
.btn{display:block;padding:.8rem 1rem;border-radius:11px;border:1px solid #2c2c32;background:#1f1f24;color:#e8e8ea;font-weight:600;cursor:pointer;margin-top:.6rem}
.btn.primary{background:#3ecf6a;border-color:#3ecf6a;color:#08240f}
.btn:disabled{opacity:.6;cursor:default}
input{padding:.8rem .9rem;border-radius:11px;border:1px solid #2c2c32;background:#0f0f12;color:#e8e8ea;letter-spacing:.06em;outline:none}
input:focus{border-color:#3ecf6a}
label.show{display:flex;align-items:center;gap:.5rem;font-size:.85rem;color:#8d8d96;margin:.6rem 0 .2rem}
label.show input{width:auto;margin:0;letter-spacing:0}
#form{display:none;margin-top:.4rem}
#form.open{display:block}
#busy{display:none;color:#b5b5bd}
#err{color:#f37165;min-height:1.5em;margin:.6rem 0 0;font-size:.9rem}
.foot{margin:1.2rem 0 0;font-size:.8rem;color:#6f6f78}
@keyframes pulse{0%,100%{opacity:.5}50%{opacity:1}}
.busy #busy{display:block;animation:pulse 1.2s ease-in-out infinite}
.busy #steps,.busy #enter,.busy #form{display:none}
</style></head><body>
<main class="card" id="card">
<div class="mark" aria-hidden="true">
<svg viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#58d97f"/><stop offset="1" stop-color="#2fb85a"/></linearGradient></defs><rect width="64" height="64" rx="15" fill="url(#g)"/><path d="M18 20l14 12-14 12" fill="none" stroke="#08240f" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/><path d="M34 46h14" fill="none" stroke="#08240f" stroke-width="6" stroke-linecap="round"/></svg>
<div><small>Remote</small><h1>Dispatch</h1></div>
</div>
<p id="busy" role="status">Signing in…</p>
<div id="steps">
<p>Connect this device to your Dispatch. On a device that is already signed in:</p>
<ol>
<li>Open <b>Settings → Access</b> and tap <b>Make a code</b>.</li>
<li>Scan its QR code with this phone's camera and open the link.</li>
</ol>
<p>No camera? Type the code instead.</p>
</div>
<button type="button" class="btn primary" id="enter">Enter a code</button>
<form id="form">
<input id="t" type="password" autocomplete="off" autocapitalize="characters" spellcheck="false" inputmode="text" placeholder="Sign-in code or access token" required aria-label="Sign-in code or access token">
<label class="show"><input id="show" type="checkbox">Show what I typed</label>
<button type="submit" class="btn primary">Sign in</button>
</form>
<p id="err" role="alert"></p>
<p class="foot">You can also paste the access token: run <code>dispatch access</code> on the computer that runs Dispatch.</p>
</main>
<script>
(function(){
var BASE=${base};
var card=document.getElementById('card'),form=document.getElementById('form'),enter=document.getElementById('enter'),t=document.getElementById('t'),err=document.getElementById('err'),show=document.getElementById('show');
enter.addEventListener('click',function(){form.classList.add('open');enter.style.display='none';t.focus();});
show.addEventListener('change',function(){t.type=show.checked?'text':'password';});
function isCode(v){return /^[A-Za-z0-9]{8}$/.test(v.replace(/[^A-Za-z0-9]/g,''));}
function go(v){
  err.textContent='';
  var body=isCode(v)?{code:v}:{token:v};
  card.classList.add('busy');
  return fetch(BASE+'/api/access/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
    .then(function(r){
      if(r.ok){location.replace(location.pathname+location.search);return;}
      card.classList.remove('busy');form.classList.add('open');enter.style.display='none';
      err.textContent=r.status===429?'Too many tries. Wait a minute and try again.':body.code?'That code is not right, was already used, or has expired. Make a new one.':'That token is not right.';
    }).catch(function(){card.classList.remove('busy');form.classList.add('open');enter.style.display='none';err.textContent='Could not reach Dispatch.';});
}
form.addEventListener('submit',function(e){e.preventDefault();go(t.value.trim());});
var m=/^#(access|code)=(.+)$/.exec(location.hash);
if(m){history.replaceState(null,'',location.pathname+location.search);go(decodeURIComponent(m[2]));}
})();
</script></body></html>`;
}

/**
 * The Content-Security-Policy for the sign-in page. It replaces the app's policy on that one response:
 * the page has an inline script (its text depends on the base path), so the policy allows that script
 * by hash and nothing else. Inline styles are allowed because the page's CSS is inline.
 */
export function signInPageCsp(basePath: string): string {
  const script = /<script>([\s\S]*?)<\/script>/.exec(signInPage(basePath))?.[1] ?? '';
  const hash = createHash('sha256').update(script).digest('base64');
  return [
    "default-src 'none'",
    `script-src 'sha256-${hash}'`,
    "style-src 'unsafe-inline'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}
