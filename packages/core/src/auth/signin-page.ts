import { createHash } from 'node:crypto';

/** The sign-in page (network exposure spec, 7.6): inline, no assets, served with status 401. */
export function signInPage(basePath: string): string {
  const base = JSON.stringify(basePath).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Dispatch: sign in</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:30rem;margin:12vh auto;padding:0 1rem;color:#1b1b1f;background:#fafafa}
@media(prefers-color-scheme:dark){body{color:#e8e8ea;background:#16161a}input{background:#222;color:inherit}}
input,button{font:inherit;padding:.5rem .7rem;margin:.3rem 0;width:100%;box-sizing:border-box}
code{background:rgba(127,127,127,.2);padding:.1rem .3rem;border-radius:4px}
#err{color:#c0392b;min-height:1.5em}
</style></head><body>
<h1>Dispatch</h1>
<p>This device is not signed in. Dispatch only lets other devices in with the access token.</p>
<p>On the computer that runs Dispatch, run <code>dispatch access</code>, then paste the token here.</p>
<form id="f"><input id="t" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Access token" required>
<button type="submit">Sign in</button></form>
<p id="err" role="alert"></p>
<script>
(function(){
var BASE=${base};
var f=document.getElementById('f'),t=document.getElementById('t'),err=document.getElementById('err');
function go(token){
  err.textContent='';
  return fetch(BASE+'/api/access/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:token})})
    .then(function(r){
      if(r.ok){location.replace(location.pathname+location.search);return;}
      err.textContent=r.status===429?'Too many tries. Wait a minute and try again.':'That token is not right.';
    }).catch(function(){err.textContent='Could not reach Dispatch.';});
}
f.addEventListener('submit',function(e){e.preventDefault();go(t.value.trim());});
var m=/^#access=(.+)$/.exec(location.hash);
if(m){history.replaceState(null,'',location.pathname+location.search);go(decodeURIComponent(m[1]));}
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
