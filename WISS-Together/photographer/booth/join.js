import { $, api } from './common.js';
$('code').value = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
const key = 'wiss-production-multi-subject';
let busy = false;
$('photographer').onclick = () => { if (!busy && $('code').value.trim()) location.href = './#' + encodeURIComponent($('code').value.trim()); };
$('subject').onclick = async () => {
  if (busy) return;
  busy = true; $('subject').disabled = $('photographer').disabled = true; $('error').textContent = '';
  try {
    const code = $('code').value.trim().toUpperCase();
    if (!/^[0-9A-F]{12}$/.test(code)) throw new Error('参加コードを確認してください');
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    if (saved?.joinCode === code) { location.href = 'subject.html'; return; }
    if (saved && !confirm('別のセッションの参加情報を置き換えます。写真の保存と共有確認は済んでいますか？')) return;
    const credentials = await api('/join', { method: 'POST', body: { joinCode: code, role: 'subject' } });
    localStorage.setItem(key, JSON.stringify({ ...credentials, joinCode: code }));
    location.href = 'subject.html';
  } catch (error) { $('error').textContent = error.message; }
  finally { busy = false; $('subject').disabled = $('photographer').disabled = false; }
};
