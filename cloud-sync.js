(function () {
  'use strict';

  const config = window.LOOP_CLOUD_CONFIG || {};
  const collections = ['scripts', 'hosts', 'rooms', 'leaves', 'shifts'];
  const localKeys = { scripts: 'loop_scripts_v1', hosts: 'loop_hosts_v1', rooms: 'loop_rooms_v1', leaves: 'loop_leaves_v1', shifts: 'mujian_shifts_v1' };
  const collectionValue = name => ({ scripts, hosts, rooms, leaves, shifts })[name];
  const setCollectionValue = (name, value) => {
    if (name === 'scripts') scripts = value.map(item => ({ ...item, cast: normalizeCast(item.cast, item.id), allowedRoomIds: (item.allowedRoomIds || []).map(String) }));
    if (name === 'hosts') hosts = value.map(item => ({ ...item, castAssignments: { ...(item.castAssignments || {}) } }));
    if (name === 'rooms') rooms = value;
    if (name === 'leaves') leaves = value;
    if (name === 'shifts') shifts = value.map(item => ({ ...item, castSelection: { ...(item.castSelection || {}) } }));
  };
  const snapshots = Object.fromEntries(collections.map(name => [name, new Map()]));
  let client = null;
  let profile = null;
  let ready = false;
  let syncQueue = Promise.resolve();
  let realtimeChannel = null;
  let recoveryMode = /(?:^|[&#?])type=recovery(?:&|$)/.test(location.hash + location.search);

  function addCloudStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .cloud-auth{position:fixed;inset:0;z-index:300;background:linear-gradient(145deg,#0c2a22,#1f5948);display:grid;place-items:center;padding:20px}.cloud-auth.hidden{display:none}.cloud-card{width:min(420px,100%);padding:30px;border-radius:22px;background:#fff;box-shadow:0 24px 70px #061c1770}.cloud-card.hidden{display:none}.cloud-brand{display:flex;align-items:center;gap:12px;margin-bottom:22px}.cloud-brand-badge{width:43px;height:43px;border:1px solid #c7d8d1;border-radius:13px;color:#1f5948;display:grid;place-items:center;font:700 19px serif}.cloud-card h2{margin:0;color:#153a30;font:700 24px serif}.cloud-card p{margin:6px 0 0;color:#718079;font-size:12px;line-height:1.65}.cloud-card label{display:grid;gap:6px;margin-top:14px;color:#38584e;font-size:12px;font-weight:700}.cloud-card input{height:44px;padding:0 12px;border:1px solid #d6e1dc;border-radius:10px;font-size:14px;outline:none}.cloud-card input:focus{border-color:#4f8b77;box-shadow:0 0 0 3px #4f8b771b}.cloud-actions{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:20px}.cloud-actions button{height:43px;border:1px solid #d6e1dc;border-radius:10px;background:#fff;color:#315c4f;font-weight:700}.cloud-actions .cloud-primary{border-color:#1e5c49;background:#1e5c49;color:#fff}.cloud-link{margin-top:12px;padding:0;border:0;color:#2b6b56;background:none;font-size:12px;text-decoration:underline;cursor:pointer}.cloud-message{min-height:20px;margin-top:12px!important;color:#a25742!important}.cloud-user{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.cloud-user strong{font-size:10px;color:#315c4f}.cloud-user button{height:30px;padding:0 10px;border:1px solid #d8e2dd;border-radius:8px;color:#5b6d66;background:#fff;font-size:9px}.sync-online{color:#246d55!important}.sync-working{color:#a06a2d!important}.sync-error{color:#a44848!important}@media(max-width:700px){.cloud-card{padding:24px 20px}.cloud-user{width:100%;justify-content:space-between}}
    `;
    document.head.appendChild(style);
  }

  function addAuthUI() {
    const wrap = document.createElement('div');
    wrap.id = 'cloudAuth';
    wrap.className = 'cloud-auth hidden';
    wrap.innerHTML = `<form class="cloud-card" id="cloudAuthForm"><div class="cloud-brand"><span class="cloud-brand-badge">环</span><div><h2>LOOP 门店协作</h2><p>登录后，所有设备会自动同步最新排班。</p></div></div><label>员工邮箱<input id="cloudEmail" type="email" autocomplete="username" required placeholder="name@example.com"></label><label>登录密码<input id="cloudPassword" type="password" autocomplete="current-password" minlength="6" required placeholder="至少 6 位"></label><div class="cloud-actions"><button type="button" id="cloudSignup">注册账户</button><button class="cloud-primary" type="submit">登录</button></div><button class="cloud-link" type="button" id="cloudForgot">忘记密码？</button><p class="cloud-message" id="cloudMessage"></p></form><form class="cloud-card hidden" id="cloudRecoveryForm"><div class="cloud-brand"><span class="cloud-brand-badge">环</span><div><h2>重设登录密码</h2><p>为你的门店账户设置新密码。</p></div></div><label>新密码<input id="cloudNewPassword" type="password" autocomplete="new-password" minlength="6" required placeholder="至少 6 位"></label><label>再次输入<input id="cloudConfirmPassword" type="password" autocomplete="new-password" minlength="6" required></label><div class="cloud-actions"><button type="submit" class="cloud-primary">保存新密码</button></div><p class="cloud-message" id="cloudRecoveryMessage"></p></form>`;
    document.body.appendChild(wrap);
    document.getElementById('cloudAuthForm').onsubmit = event => { event.preventDefault(); signIn(); };
    document.getElementById('cloudSignup').onclick = signUp;
    document.getElementById('cloudForgot').onclick = sendRecoveryEmail;
    document.getElementById('cloudRecoveryForm').onsubmit = event => { event.preventDefault(); finishRecovery(); };
  }

  function authMessage(message) { document.getElementById('cloudMessage').textContent = message || ''; }
  function showAuth(message = '') { document.getElementById('cloudAuth').classList.remove('hidden'); authMessage(message); }
  function hideAuth() { document.getElementById('cloudAuth').classList.add('hidden'); authMessage(''); }
  function showRecovery() { recoveryMode = true; document.getElementById('cloudAuthForm').classList.add('hidden'); document.getElementById('cloudRecoveryForm').classList.remove('hidden'); document.getElementById('cloudAuth').classList.remove('hidden'); }
  function credentials() { return { email: document.getElementById('cloudEmail').value.trim(), password: document.getElementById('cloudPassword').value }; }

  async function signIn() {
    authMessage('正在登录…');
    const { error } = await client.auth.signInWithPassword(credentials());
    if (error) return authMessage(error.message === 'Invalid login credentials' ? '邮箱或密码不正确。可点“忘记密码？”重设。' : `登录失败：${error.message}`);
    await startSession(true);
  }

  async function signUp() {
    const values = credentials();
    if (!values.email || values.password.length < 6) return authMessage('请填写邮箱，并设置至少 6 位密码。');
    authMessage('正在创建账户…');
    const { data, error } = await client.auth.signUp({ ...values, options: { emailRedirectTo: config.authRedirectUrl } });
    if (error) return authMessage(`注册失败：${error.message}`);
    if (!data.session) return authMessage('账户已创建，请查收验证邮件后再登录。');
    await startSession(true);
  }

  async function sendRecoveryEmail() {
    const email = document.getElementById('cloudEmail').value.trim();
    if (!email) return authMessage('请先填写员工邮箱，再点击“忘记密码？”。');
    authMessage('正在发送重设邮件…');
    const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: config.authRedirectUrl });
    authMessage(error ? `发送失败：${error.message}` : '重设邮件已发送。请查收邮箱并点击邮件中的链接。');
  }

  async function finishRecovery() {
    const password = document.getElementById('cloudNewPassword').value;
    const confirm = document.getElementById('cloudConfirmPassword').value;
    const message = document.getElementById('cloudRecoveryMessage');
    if (password.length < 6 || password !== confirm) { message.textContent = '两次输入的密码需一致，且至少 6 位。'; return; }
    message.textContent = '正在保存新密码…';
    const { error } = await client.auth.updateUser({ password });
    if (error) { message.textContent = `保存失败：${error.message}`; return; }
    recoveryMode = false;
    document.getElementById('cloudRecoveryForm').classList.add('hidden');
    document.getElementById('cloudAuthForm').classList.remove('hidden');
    await startSession(true);
  }

  async function loadProfile(allowBootstrap = false) {
    const { data: { user } } = await client.auth.getUser();
    if (!user) return null;
    let result = await client.from('profiles').select('id,store_id,role,host_id,display_name,status').eq('id', user.id).maybeSingle();
    if (!result.data && allowBootstrap) {
      await client.rpc('claim_first_admin', { requested_store_id: config.storeId });
      result = await client.from('profiles').select('id,store_id,role,host_id,display_name,status').eq('id', user.id).maybeSingle();
    }
    return result.data || null;
  }

  function setStatus(text, className = '') {
    const status = document.getElementById('saveState');
    if (!status) return;
    status.textContent = text;
    status.classList.remove('sync-online', 'sync-working', 'sync-error');
    if (className) status.classList.add(className);
  }

  function mountUserBadge(user) {
    document.getElementById('cloudUserBadge')?.remove();
    const badge = document.createElement('div');
    badge.id = 'cloudUserBadge';
    badge.className = 'cloud-user';
    badge.innerHTML = `<strong>${escapeHtml(profile.display_name || user.email || '已登录')} · ${profile.role === 'admin' ? '管理员' : '主持人'}</strong><button type="button">退出</button>`;
    badge.querySelector('button').onclick = async () => { await client.auth.signOut(); location.reload(); };
    document.querySelector('.top-actions')?.prepend(badge);
  }

  function applyRole() {
    viewerMode = profile.role === 'admin' ? 'admin' : 'host';
    if (viewerMode === 'host') viewerHostId = String(profile.host_id || '');
    const mode = document.getElementById('viewerMode');
    if (mode) { mode.value = viewerMode; mode.disabled = true; }
    window.LOOP_CLOUD_ACTIVE = true;
    localStorage.setItem('loop_viewer_mode_v1', viewerMode);
    localStorage.setItem('loop_viewer_host_v1', viewerHostId);
  }

  function rememberRows(rows) {
    collections.forEach(name => snapshots[name].clear());
    rows.forEach(row => snapshots[row.collection]?.set(String(row.entity_id), JSON.stringify(row.data)));
  }

  function applyRows(rows) {
    const grouped = Object.fromEntries(collections.map(name => [name, []]));
    rows.forEach(row => grouped[row.collection]?.push(row.data));
    collections.forEach(name => setCollectionValue(name, grouped[name]));
    rememberRows(rows);
    if (profile.role === 'host') viewerHostId = String(profile.host_id || '');
    else if (!hosts.some(host => String(host.id) === String(viewerHostId))) viewerHostId = hosts[0]?.id || '';
    selected = shifts.find(shift => shift.date?.startsWith(monthKey()))?.id || shifts[0]?.id || null;
    optimizationCache.key = '';
    render();
    if (currentView !== 'schedule') renderManager();
  }

  async function loadCloudData() {
    const { data, error } = await client.from('store_entities').select('collection,entity_id,data,updated_at').eq('store_id', profile.store_id);
    if (error) throw error;
    if (!data.length) {
      const localDraft = Object.fromEntries(collections.map(name => [name, collectionValue(name).map(item => structuredClone(item))]));
      const hasSavedData = collections.some(name => localStorage.getItem(localKeys[name]) !== null);
      applyRows([]);
      if (profile.role === 'admin' && hasSavedData && confirm('云端目前没有门店资料。是否将这台设备保存的剧本、主持人、房间、请假和排班导入云端？')) {
        collections.forEach(name => setCollectionValue(name, localDraft[name]));
        for (const name of collections) await syncCollection(name, true);
        render();
        showToast('本机资料已导入云端');
      }
      return;
    }
    applyRows(data);
  }

  async function syncHostInvites() {
    if (profile?.role !== 'admin') return;
    const invitations = hosts.filter(host => host.email && host.status !== '停用').map(host => ({ store_id: profile.store_id, email: String(host.email).trim().toLowerCase(), role: 'host', host_id: String(host.id), display_name: host.name }));
    if (invitations.length) {
      const { error } = await client.from('staff_invites').upsert(invitations, { onConflict: 'store_id,email' });
      if (error) throw error;
    }
    const { data: existing, error: readError } = await client.from('staff_invites').select('id,email').eq('store_id', profile.store_id).eq('role', 'host');
    if (readError) throw readError;
    const validEmails = new Set(invitations.map(item => item.email));
    const staleIds = (existing || []).filter(item => !validEmails.has(item.email)).map(item => item.id);
    if (staleIds.length) {
      const { error } = await client.from('staff_invites').delete().eq('store_id', profile.store_id).in('id', staleIds);
      if (error) throw error;
    }
  }

  async function syncCollection(name, force = false) {
    if (!ready && !force) return;
    const current = collectionValue(name);
    const previous = snapshots[name];
    const nextIds = new Set(current.map(item => String(item.id)));
    const changed = current.filter(item => force || previous.get(String(item.id)) !== JSON.stringify(item));
    const removed = [...previous.keys()].filter(id => !nextIds.has(id));
    if (changed.length) {
      const rows = changed.map(item => ({ store_id: profile.store_id, collection: name, entity_id: String(item.id), data: item, updated_by: profile.id }));
      const { error } = await client.from('store_entities').upsert(rows, { onConflict: 'store_id,collection,entity_id' });
      if (error) throw error;
      changed.forEach(item => previous.set(String(item.id), JSON.stringify(item)));
    }
    if (removed.length) {
      const { error } = await client.from('store_entities').delete().eq('store_id', profile.store_id).eq('collection', name).in('entity_id', removed);
      if (error) throw error;
      removed.forEach(id => previous.delete(id));
    }
    if (name === 'hosts') await syncHostInvites();
  }

  function queueSync(names) {
    if (!ready) return;
    setStatus('正在同步…', 'sync-working');
    syncQueue = syncQueue.then(async () => {
      for (const name of names) await syncCollection(name);
      setStatus('已同步至云端', 'sync-online');
    }).catch(error => {
      console.error(error);
      setStatus('同步失败，稍后重试', 'sync-error');
      showToast('云端同步失败，请检查网络后重试');
    });
  }

  function applyRealtime(payload) {
    if (!ready) return;
    const row = payload.new || payload.old;
    if (!row || !collections.includes(row.collection)) return;
    if (payload.eventType !== 'DELETE' && snapshots[row.collection].get(String(row.entity_id)) === JSON.stringify(row.data)) return;
    const list = collectionValue(row.collection);
    const index = list.findIndex(item => String(item.id) === String(row.entity_id));
    if (payload.eventType === 'DELETE') {
      if (index >= 0) list.splice(index, 1);
      snapshots[row.collection].delete(String(row.entity_id));
    } else {
      if (index >= 0) list[index] = row.data; else list.push(row.data);
      setCollectionValue(row.collection, list.slice());
      snapshots[row.collection].set(String(row.entity_id), JSON.stringify(row.data));
    }
    optimizationCache.key = '';
    render();
    if (currentView !== 'schedule') renderManager();
    setStatus('已收到最新数据', 'sync-online');
    showToast('其他设备的修改已同步');
  }

  function subscribeRealtime() {
    realtimeChannel?.unsubscribe();
    realtimeChannel = client.channel(`loop-store-${profile.store_id}`).on('postgres_changes', { event: '*', schema: 'public', table: 'store_entities', filter: `store_id=eq.${profile.store_id}` }, applyRealtime).subscribe(status => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        setStatus('实时连接中断，正在重连', 'sync-error');
      }
    });
  }

  function installPersistenceHooks() {
    const localPersistShifts = persistShifts;
    const localPersistCollections = persistCollections;
    persistShifts = function () { localPersistShifts(); queueSync(['shifts']); };
    persistCollections = function () { localPersistCollections(); queueSync(profile?.role === 'host' ? ['leaves'] : ['scripts', 'hosts', 'rooms', 'leaves']); };
  }

  async function startSession(allowBootstrap = false) {
    try {
      profile = await loadProfile(allowBootstrap);
      if (!profile || profile.status !== 'active') {
        showAuth('账号尚未加入门店。请让管理员在对应主持人资料中填写你的登录邮箱。');
        return;
      }
      const { data: { user } } = await client.auth.getUser();
      hideAuth();
      applyRole();
      mountUserBadge(user);
      setStatus('正在读取云端数据…', 'sync-working');
      await loadCloudData();
      ready = true;
      subscribeRealtime();
      document.body.classList.remove('cloud-pending');
      render();
      setStatus('已同步至云端', 'sync-online');
    } catch (error) {
      console.error(error);
      showAuth('云端连接失败，请稍后重试。');
    }
  }

  async function init() {
    addCloudStyles();
    addAuthUI();
    if (!config.supabaseUrl || !config.supabaseAnonKey || !window.supabase?.createClient) {
      return showAuth('云端组件未加载，请检查网络并刷新页面。');
    }
    client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    client.auth.onAuthStateChange(event => { if (event === 'PASSWORD_RECOVERY') showRecovery(); });
    installPersistenceHooks();
    const { data: { session } } = await client.auth.getSession();
    if (recoveryMode) return showRecovery();
    if (!session) return showAuth();
    await startSession(true);
  }

  window.addEventListener('online', () => queueSync(collections));
  init();
})();
