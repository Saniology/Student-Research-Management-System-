import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Archive, ArrowRight, BookOpen, Check, CheckCircle2, CircleDollarSign, Download, FileCheck2, FileText, GraduationCap, Library, LockKeyhole, PencilLine, Plus, QrCode, RefreshCw, Save, Search, Send, Settings2, ShieldCheck, UserCheck, Users, XCircle } from 'lucide-react';
import { AppShell, EmptyState, SearchBox, SectionHeader } from './components/AppShell';
import { Modal } from './components/Modal';
import { PageSkeleton } from './components/Skeleton';
import { StatusChip } from './components/StatusChip';
import { config, fallbackTenant, invoke, loadProfile, loadSystemConfig, loadTenant, signedPdfUrl, supabase } from './lib/supabase';
import { fetchQrSvg, issueReceipt, lookupVerification, retryPaymentVerification, runDueReports, runScheduledReport, workflowActions } from './lib/contracts';
import { demoProjects, demoReviewProjects, demoStats } from './data/demo';
import './styles.css';

const previewParams = new URLSearchParams(window.location.search);
const isLocalHost = hostname => ['localhost', '127.0.0.1', '0.0.0.0'].includes(hostname);
const isRolePreviewAllowed = () => isLocalHost(window.location.hostname) && ['student', 'teacher', 'library', 'admin'].includes(previewParams.get('preview_role'));
const previewRole = isRolePreviewAllowed() ? previewParams.get('preview_role') : '';
const previewAction = previewParams.get('preview_action') || '';

function formatNaira(kobo = 0) { return new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 }).format(Number(kobo) / 100); }
function displayDate(value) { return value ? new Date(value).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; }

export default function App() {
  const [tenant, setTenant] = useState(fallbackTenant);
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [view, setView] = useState(previewRole || 'landing');
  const [booting, setBooting] = useState(true);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState('login');
  const [toast, setToast] = useState('');
  const [notifications, setNotifications] = useState([]);

  const notify = useCallback(message => { setToast(message); window.setTimeout(() => setToast(''), 4200); }, []);
  const role = profile?.role || (previewRole || '');

  useEffect(() => {
    document.documentElement.dataset.rolePreview = previewRole || '';
    document.documentElement.dataset.rolePreviewAction = previewAction;
    const bootstrap = async () => {
      if (previewRole) {
        setTenant(fallbackTenant);
        setProfile({ id: `preview-${previewRole}-user`, role: previewRole, full_name: previewRole === 'teacher' ? 'Dr. Sani Musa' : previewRole === 'admin' ? 'SPMS Administrator' : previewRole === 'library' ? 'Library Officer' : 'Musa Abdullahi', matric: 'KASU/SCI/20/123', department: 'Computer Science', email: `${previewRole}.preview@kasu.edu.ng` });
        setBooting(false);
        return;
      }
      const slug = new URLSearchParams(window.location.search).get('tenant') || window.SPMS_DEFAULT_TENANT_SLUG || 'kasu';
      const [loadedTenant, currentSession] = await Promise.all([loadTenant(slug, window.location.hostname), supabase?.auth.getSession().then(result => result.data.session)]);
      setTenant(loadedTenant);
      if (currentSession) {
        setSession(currentSession);
        try { setProfile(await loadProfile(currentSession.user.id)); } catch (error) { notify(error.message); }
      }
      setBooting(false);
    };
    bootstrap();
    if (!supabase || previewRole) return undefined;
    const { data } = supabase.auth.onAuthStateChange(async (_event, nextSession) => {
      setSession(nextSession);
      if (nextSession) setProfile(await loadProfile(nextSession.user.id)); else setProfile(null);
    });
    return () => data.subscription.unsubscribe();
  }, [notify]);

  useEffect(() => {
    if (!supabase || !session || previewRole) return undefined;
    const fetchNotifications = async () => {
      const { data } = await supabase.from('notifications').select('*').eq('recipient_id', session.user.id).is('read_at', null).order('created_at', { ascending: false }).limit(10);
      setNotifications(data || []);
    };
    fetchNotifications();
    return undefined;
  }, [session]);

  const goHome = () => setView('landing');
  const openLogin = () => { setAuthMode('login'); setAuthOpen(true); };
  const logout = async () => { if (supabase) await supabase.auth.signOut(); setSession(null); setProfile(null); setView('landing'); notify('You have been signed out.'); };
  const enterWorkspace = nextRole => { setView(nextRole); setAuthOpen(false); };
  const handleDownload = async project => {
    if (!session) { openLogin(); return; }
    if (previewRole || project?.id?.startsWith('demo-')) { notify('Preview download is protected by the repository payment gate.'); return; }
    try {
      const access = await invoke('repository-access', { action: 'get_download_url', project_id: project.id });
      if (access.signed_url) { window.open(access.signed_url, '_blank', 'noopener'); return; }
      const payment = await invoke('repository-access', { action: 'initialize_download', project_id: project.id });
      if (!window.PaystackPop) throw new Error('Paystack failed to load. Refresh and try again.');
      window.PaystackPop.resumeTransaction(payment.access_code, { onSuccess: async response => { const reference = response?.reference || response?.trxref || payment.reference; const result = await invoke('repository-access', { action: 'verify_download', project_id: project.id, reference }); if (result.signed_url) window.open(result.signed_url, '_blank', 'noopener'); notify('Watermarked download unlocked for five minutes.'); }, onCancel: () => notify('Download payment was cancelled.'), onError: error => notify(error?.message || 'Paystack could not open.') });
    } catch (error) { notify(error.message); }
  };

  if (booting) return <><AppShell tenant={tenant} onHome={goHome} onLogin={openLogin}><PageSkeleton role="landing" /></AppShell></>;
  return <AppShell tenant={tenant} role={role} onHome={goHome} onLogin={openLogin} onLogout={logout} notificationCount={notifications.length} onNotifications={() => notify(notifications.length ? `${notifications.length} unread notification${notifications.length === 1 ? '' : 's'}.` : 'You are all caught up.') }>
    {view === 'landing' && <Landing tenant={tenant} session={session} onLogin={openLogin} onWorkspace={() => role ? enterWorkspace(role) : openLogin()} onDownload={handleDownload} configError={!config.valid && !previewRole} />}
    {view === 'student' && <StudentWorkspace profile={profile} session={session} preview={Boolean(previewRole)} onToast={notify} />}
    {view === 'teacher' && <TeacherWorkspace profile={profile} session={session} preview={Boolean(previewRole)} onToast={notify} />}
    {view === 'library' && <LibraryWorkspace profile={profile} session={session} preview={Boolean(previewRole)} onToast={notify} />}
    {view === 'admin' && <AdminWorkspace profile={profile} session={session} preview={Boolean(previewRole)} onToast={notify} />}
    <AuthModal open={authOpen} mode={authMode} onClose={() => setAuthOpen(false)} onModeChange={setAuthMode} onSuccess={(nextSession, nextProfile) => { setSession(nextSession); setProfile(nextProfile); enterWorkspace(nextProfile.role); }} onToast={notify} />
    {toast && <div className="toast" role="status">{toast}</div>}
  </AppShell>;
}

function Landing({ tenant, session, onLogin, onWorkspace, onDownload, configError }) {
  const [query, setQuery] = useState('');
  const [projects, setProjects] = useState(demoProjects);
  const [abstractProject, setAbstractProject] = useState(null);
  useEffect(() => {
    if (!supabase) return undefined;
    supabase.from('public_catalog').select('id, title, author_name, department_name, degree, abstract, published_at, project_id').order('published_at', { ascending: false }).limit(12).then(({ data }) => {
      if (data?.length) setProjects(data.map(item => ({ ...item, author: item.author_name, dept: item.department_name, status: 'published' })));
    });
    return undefined;
  }, []);
  const visibleProjects = projects.filter(project => [project.title, project.author, project.dept, project.degree].join(' ').toLowerCase().includes(query.toLowerCase()));
  return <div className="blueprint">
    {configError && <div className="config-alert" id="app-config-error" role="alert"><Settings2 size={16} /><span>Browser configuration is incomplete. Add the public Supabase URL, anon key, and Paystack public key in <code>js/config.js</code> before signing in or submitting.</span></div>}
    <section className="hero"><div className="hero-grid"><div><p className="eyebrow">{tenant.name || 'Kaduna State University'}</p><h1>{tenant.short_name || 'KASU'} <span>SPMS</span></h1><p className="hero-copy">A single workspace for final-year submissions, supervisor review, library publishing, verified receipts, Paystack reconciliation, and controlled repository access.</p><div className="hero-actions"><button className="button button-accent" onClick={onLogin}><LogInIcon />Login to portal</button><button className="button button-ghost" onClick={() => document.getElementById('repository')?.scrollIntoView({ behavior: 'smooth' })}><Search size={16} />Browse repository</button>{session ? <button className="button button-ghost" onClick={onWorkspace}><ArrowRight size={16} />Open workspace</button> : <button className="button button-ghost" onClick={onLogin}>Create account</button>}</div></div><OperationsBoard /></div></section>
    <div className="trust-band"><ShieldCheck size={15} /> Simple, auditable workflow from submission to digital clearance</div>
    <section className="timeline-section"><div className="center-heading"><p className="eyebrow">One connected process</p><h2>The Clearance Process</h2><p className="muted">Every stage is visible, accountable, and connected from the first student submission to final digital clearance.</p></div><div className="timeline">{[[GraduationCap,'Student Login'],[FileText,'Upload Thesis'],[UserCheck,'Supervisor Approval'],[Library,'Library Verification'],[CheckCircle2,'Clearance Completed']].map(([Icon, label]) => <div className="timeline-step" key={label}><span className="timeline-icon"><Icon size={19} /></span><strong>{label}</strong></div>)}</div></section>
    <section className="impact-section"><div className="center-heading"><p className="eyebrow">Institutional signal</p><h2>Institutional Impact</h2></div><div className="metrics-grid">{[[demoStats.students,'Students'],[demoStats.submitted,'Projects submitted'],[demoStats.approved,'Approved'],[demoStats.departments,'Departments']].map(([value,label]) => <div className="impact-metric" key={label}><strong>{value}</strong><span>{label}</span></div>)}</div></section>
    <section className="repository-section" id="repository"><div className="page-pad" style={{ paddingTop: 0, paddingBottom: 0 }}><SectionHeader eyebrow="Public repository" title="Browse Past Research" copy="Read approved abstracts for free. Full thesis access remains controlled and attributable." action={<span className="tag"><LockKeyhole size={12} />Private files protected</span>} /><div className="repository-toolbar"><SearchBox value={query} onChange={setQuery} /><span className="muted" style={{ fontSize: '.75rem', alignSelf: 'center' }}>{visibleProjects.length} catalog records</span></div><div className="repo-grid">{visibleProjects.map(project => <ProjectCard project={project} key={project.id} onAbstract={() => setAbstractProject(project)} onDownload={onDownload} />)}</div>{!visibleProjects.length && <EmptyState icon={Search} title="No matching research" copy="Try a broader title, author, or department search." />}</div></section>
    <VerificationBox />
    <Modal open={Boolean(abstractProject)} onClose={() => setAbstractProject(null)} eyebrow="Public catalog" title={abstractProject?.title || ''}><p className="muted" style={{ lineHeight: 1.7 }}>{abstractProject?.abstract}</p><div className="project-meta" style={{ marginTop: '1rem' }}><span>{abstractProject?.author}</span><span>{abstractProject?.dept}</span></div></Modal>
  </div>;
}

function VerificationBox() {
  const [type, setType] = useState('receipt');
  const [value, setValue] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const verify = async event => {
    event.preventDefault();
    if (!value.trim()) return;
    setBusy(true); setResult(null);
    try { setResult(await lookupVerification(type, type === 'receipt' ? { verification_code: value.trim() } : type === 'project' ? { project_id: value.trim() } : { verification_code: value.trim() })); }
    catch (error) { setResult({ error: error.message }); }
    finally { setBusy(false); }
  };
  return <section className="verification-section"><div className="page-pad"><SectionHeader eyebrow="Public verification" title="Check a receipt or catalogue record" copy="Confirm published research and digital clearance without exposing private thesis files." /><form className="verification-form" onSubmit={verify}><div className="field"><label htmlFor="verification-type">Verification type</label><select id="verification-type" value={type} onChange={event => setType(event.target.value)}><option value="receipt">Clearance receipt</option><option value="project">Public project</option><option value="qr_svg">QR verification code</option></select></div><div className="field verification-value"><label htmlFor="verification-value">Verification code</label><input id="verification-value" value={value} onChange={event => setValue(event.target.value)} placeholder="Enter a public code" /></div><button className="button button-primary" disabled={busy}>{busy ? 'Checking...' : 'Verify record'}</button></form>{result && <div className={`verification-result ${result.error ? 'is-error' : ''}`} role="status"><strong>{result.error ? 'Verification failed' : 'Record verified'}</strong><pre>{JSON.stringify(result, null, 2)}</pre></div>}</div></section>;
}

function LogInIcon() { return <ArrowRight size={16} />; }
function OperationsBoard() { return <div className="operations-board"><div className="board-head"><div><p className="eyebrow">Operations board</p><h2>Clearance Pipeline</h2></div><span className="status-chip status-published"><span className="status-dot" />Ready</span></div>{[[FileText,'Student submission','Metadata, PDF, and fee captured together.','PDF'],[UserCheck,'Supervisor review','Approvals, revisions, and comments stay auditable.','RLS'],[BookOpen,'Library publishing','Public metadata, shelf details, and QR verification.','QR'],[CircleDollarSign,'Finance evidence','Paystack references support reconciliation.','AUDIT']].map(([Icon,title,copy,tag]) => <div className="pipeline-row" key={title}><span className="pipeline-icon"><Icon size={16} /></span><div><p>{title}</p><p>{copy}</p></div><span className="tag">{tag}</span></div>)}</div>; }
function ProjectCard({ project, onAbstract, onDownload }) { return <article className="project-card"><div className="project-meta"><span className="tag">{project.degree || 'Research'}</span><span>{project.dept || 'Institution'}</span></div><h3>{project.title}</h3><p>{project.abstract}</p><div className="card-actions"><button className="button button-ghost button-small" onClick={onAbstract}>View abstract</button><button className="button button-primary button-small" onClick={() => onDownload(project)}><Download size={14} />Download</button></div></article>; }

function AuthModal({ open, mode, onClose, onModeChange, onSuccess, onToast }) {
  const [form, setForm] = useState({ email: '', password: '', full_name: '', matric: '', department: '' });
  const [busy, setBusy] = useState(false);
  const submit = async event => {
    event.preventDefault();
    if (!supabase) { onToast('Supabase is not configured for this browser.'); return; }
    setBusy(true);
    try {
      if (mode === 'signup') {
        const { data, error } = await supabase.auth.signUp({ email: form.email, password: form.password, options: { data: { full_name: form.full_name, matric: form.matric, department: form.department, role: 'student' } } });
        if (error) throw error;
        if (!data.session) { onToast('Account created. Check your email to confirm access.'); onClose(); return; }
        onSuccess(data.session, await loadProfile(data.user.id));
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({ email: form.email, password: form.password });
        if (error) throw error;
        onSuccess(data.session, await loadProfile(data.user.id));
      }
    } catch (error) { onToast(error.message); } finally { setBusy(false); }
  };
  return <Modal open={open} onClose={onClose} eyebrow="Secure access" title={mode === 'login' ? 'Welcome back' : 'Create a student account'}><form className="auth-form" onSubmit={submit}>{mode === 'signup' && <><div className="field"><label htmlFor="auth-name">Full name</label><input id="auth-name" required value={form.full_name} onChange={e => setForm({ ...form, full_name: e.target.value })} /></div><div className="form-grid"><div className="field"><label htmlFor="auth-matric">Matric number</label><input id="auth-matric" required value={form.matric} onChange={e => setForm({ ...form, matric: e.target.value })} /></div><div className="field"><label htmlFor="auth-dept">Department</label><input id="auth-dept" required value={form.department} onChange={e => setForm({ ...form, department: e.target.value })} /></div></div></>}<div className="field"><label htmlFor="auth-email">Email address</label><input id="auth-email" type="email" required value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></div><div className="field"><label htmlFor="auth-password">Password</label><input id="auth-password" type="password" minLength="8" required value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} /></div><button className="button button-primary" disabled={busy}>{busy ? 'Working...' : mode === 'login' ? 'Sign in' : 'Create account'}</button></form><p className="auth-switch">{mode === 'login' ? 'New to the portal?' : 'Already registered?'} <button onClick={() => onModeChange(mode === 'login' ? 'signup' : 'login')}>{mode === 'login' ? 'Create an account' : 'Sign in instead'}</button></p></Modal>;
}

function Workspace({ role, title, subtitle, children, sidebar = [] }) { return <div className="workspace-shell"><aside className="sidebar"><div className="sidebar-head"><span className="sidebar-mark"><ShieldCheck size={18} /></span><div><strong>{role === 'teacher' ? 'Supervisor' : role[0].toUpperCase() + role.slice(1)} panel</strong><small>Operations center</small></div></div><nav className="sidebar-nav">{sidebar.map(([Icon,label,active,onClick]) => <button className={active ? 'active' : ''} key={label} onClick={onClick}><Icon size={16} />{label}</button>)}</nav></aside><section className="workspace-main blueprint"><div className="workspace-head"><div><p className="eyebrow">{role === 'teacher' ? 'Review workspace' : 'Operations workspace'}</p><h1>{title}</h1><p>{subtitle}</p></div></div>{children}</section></div>; }
function MetricCards({ items }) { return <div className="metric-grid">{items.map(([label,value,Icon]) => <div className="metric-card" key={label}><div className="metric-icon"><Icon size={16} /></div><small>{label}</small><strong>{value}</strong></div>)}</div>; }

function StudentWorkspace({ profile, session, preview, onToast }) {
  const revisionPreview = preview && previewAction === 'show_revision';
  const [project, setProject] = useState(revisionPreview ? { id: 'preview-project', title: 'Web-Based E-Voting System', degree: 'BSc', abstract: 'A final-year project workflow preview for supervisor review, library publication, payment clearance, and repository verification.', status: 'revision_requested', revision_note: 'Please replace the PDF with the corrected version and resubmit.' } : preview ? { id: 'preview-project', title: 'Web-Based E-Voting System', degree: 'BSc', abstract: 'A final-year project workflow preview for supervisor review, library publication, payment clearance, and repository verification.', status: 'published' } : null);
  const [payment, setPayment] = useState(preview ? { amount: 200000, paystack_reference: 'SPMS-PREVIEW-STUDENT', paid_at: new Date().toISOString() } : null);
  const [loading, setLoading] = useState(!preview);
  const [form, setForm] = useState({ title: 'Web-Based E-Voting System', degree: 'BSc', abstract: 'A final-year project workflow preview for supervisor review, library publication, payment clearance, and repository verification.' });
  const [file, setFile] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [receiptQrUrl, setReceiptQrUrl] = useState('');
  const [clearanceFee, setClearanceFee] = useState(200000);
  useEffect(() => {
    if (preview || !session || !supabase) return undefined;
    Promise.all([
      supabase.from('projects').select('*').eq('student_id', session.user.id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('payments').select('*').eq('student_id', session.user.id).eq('status', 'success').order('created_at', { ascending: false }).limit(1).maybeSingle(),
      loadSystemConfig(profile?.institution_id),
    ]).then(([projectResult, paymentResult, configResult]) => { setProject(projectResult.data || null); setPayment(paymentResult.data || null); setClearanceFee(configResult?.clearance_fee_kobo || 200000); if (projectResult.data) setForm({ title: projectResult.data.title || '', degree: projectResult.data.degree || 'BSc', abstract: projectResult.data.abstract || '' }); }).catch(error => onToast(error.message || 'Student workspace could not be loaded.')).finally(() => setLoading(false));
    return undefined;
  }, [onToast, preview, session, profile]);
  useEffect(() => { let active = true; let objectUrl = ''; if (!receipt?.qr_payload) { setReceiptQrUrl(''); return undefined; } fetchQrSvg(receipt.qr_payload).then(url => { objectUrl = url; if (active) setReceiptQrUrl(url); }).catch(() => { if (active) setReceiptQrUrl(''); }); return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); }; }, [receipt?.qr_payload]);
  const submit = async event => {
    event.preventDefault();
    if (!file) { onToast('Choose the thesis PDF before continuing.'); return; }
    if (form.abstract.trim().length < 50) { onToast('Provide an abstract of at least 50 characters.'); return; }
    if (!session || preview) { onToast('Preview mode shows the complete workflow without creating a transaction.'); return; }
    try {
      if (project?.status === 'revision_requested' && payment) {
        const path = `${session.user.id}/${Date.now()}-revision-${file.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
        const upload = await supabase.storage.from('thesis-pdfs').upload(path, file, { contentType: 'application/pdf', upsert: false });
        if (upload.error) throw upload.error;
        const data = await invoke('project-workflow', { action: 'student_resubmit', project_id: project.id, file_path: upload.data.path, file_name: file.name, file_size_bytes: file.size, title: form.title, abstract: form.abstract, degree: form.degree });
        setProject(data.project); setFile(null); onToast('Revision resubmitted. No second payment was taken.'); return;
      }
      const init = await invoke('verify-paystack', { action: 'initialize_clearance' });
      if (!window.PaystackPop) throw new Error('Paystack failed to load. Refresh and try again.');
      window.PaystackPop.resumeTransaction(init.access_code, { onSuccess: async response => { const reference = response?.reference || response?.trxref || init.reference; const path = `${session.user.id}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`; const upload = await supabase.storage.from('thesis-pdfs').upload(path, file, { contentType: 'application/pdf', upsert: false }); if (upload.error) throw upload.error; const data = await retryPaymentVerification(reference, { file_name: file.name, file_path: upload.data.path, title: form.title, abstract: form.abstract, degree: form.degree, file_size_bytes: file.size }); setPayment(data.payment); setProject(data.project); setFile(null); onToast('Payment verified and thesis submitted for review.'); }, onCancel: () => onToast('Payment was cancelled.'), onError: error => onToast(error?.message || 'Paystack could not open.') });
    } catch (error) { onToast(error.message); }
  };
  const generateReceipt = async () => {
    if (preview) { onToast('Preview receipt is available after the library publishes the record.'); return; }
    if (!project || !['published', 'cleared'].includes(project.status)) { onToast('The receipt becomes available after library publishing.'); return; }
    try { const data = await issueReceipt(project.id); setReceipt(data.receipt); setProject(data.project || { ...project, status: 'cleared' }); onToast('Digital clearance receipt issued.'); }
    catch (error) { onToast(error.message); }
  };
  if (loading) return <PageSkeleton role="student" />;
  return <Workspace role="student" title="Your clearance workspace" subtitle="Submit once, follow every review stage, and keep your official receipt close." sidebar={[[GraduationCap,'My workspace',true],[FileText,'Submission'],[CircleDollarSign,'Payments'],[ShieldCheck,'Receipt']]}><MetricCards items={[["Workflow status", project ? project.status.replaceAll('_',' ') : 'Not started', FileCheck2],["Clearance fee", formatNaira(clearanceFee), CircleDollarSign],["Submission", project ? 'Received' : 'Awaiting upload', FileText],["Receipt", project?.status === 'cleared' ? 'Ready' : 'After clearance', Archive]]} /><div className="workspace-grid"><section className="surface span-two"><div className="surface-head"><div><h2>Submission details</h2><p>Capture the metadata your supervisor and library will verify.</p></div>{project && <StatusChip status={project.status} />}</div>{project?.status === 'revision_requested' && <div className="revision-banner"><strong>Revision Required</strong><span>Upload the corrected PDF and resubmit without paying the clearance fee again.</span></div>}<form className="form-grid" onSubmit={submit}><div className="field full"><label htmlFor="project-title-input">Project title</label><input id="project-title-input" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></div><div className="field"><label htmlFor="project-degree-input">Degree</label><select id="project-degree-input" value={form.degree} onChange={e => setForm({ ...form, degree: e.target.value })}><option>BSc</option><option>PGD</option><option>MSc</option><option>PhD</option></select></div><div className="field"><label htmlFor="thesis-pdf-input">Thesis PDF</label><input id="thesis-pdf-input" type="file" accept="application/pdf,.pdf" onChange={e => setFile(e.target.files?.[0] || null)} /></div><div className="field full"><label htmlFor="project-abstract-input">Abstract</label><textarea id="project-abstract-input" value={form.abstract} onChange={e => setForm({ ...form, abstract: e.target.value })} /><span className="helper">Minimum 50 characters. This abstract becomes part of the public catalog after library approval.</span></div><div className="modal-actions field full"><button className="button button-primary" id="pay-btn" disabled={Boolean(project && ['published','cleared'].includes(project.status))}>{project?.status === 'revision_requested' && payment ? <><RefreshCw size={15} />Upload Revision &amp; Resubmit</> : payment ? <><Check size={15} />Submission successful</> : <><CircleDollarSign size={15} />Pay &amp; submit thesis</>}</button></div></form></section><section className="surface"><div className="surface-head"><div><h2>Current status</h2><p>Live workflow checkpoints.</p></div><LockKeyhole size={17} color="#065f46" /></div>{project ? <div className="status-panel"><h3>{project.title}</h3><StatusChip status={project.status} /><div className="progress-track"><div className="progress-fill" style={{ width: `${['submitted','supervisor_review','revision_requested'].includes(project.status) ? 34 : project.status === 'supervisor_approved' ? 62 : project.status === 'library_review' ? 80 : 100}%` }} /></div>{project.revision_note && <p className="helper"><strong>Supervisor note:</strong> {project.revision_note}</p>}</div> : <EmptyState icon={FileText} title="No submission yet" copy="Complete the form to start your clearance journey." />}</section><section className="surface"><div className="surface-head"><div><h2>Payment evidence</h2><p>Every successful payment is tied to your account.</p></div><CircleDollarSign size={17} color="#065f46" /></div>{payment ? <div className="receipt" id="receipt-section"><h3>{previewAction === 'show_receipt' || project?.status === 'cleared' ? 'Digital Clearance Receipt' : 'Payment captured'}</h3><dl><dt>Reference</dt><dd>{payment.paystack_reference}</dd><dt>Amount</dt><dd>{formatNaira(payment.amount)}</dd><dt>Date</dt><dd>{displayDate(payment.paid_at)}</dd></dl>{receiptQrUrl && <div className="qr-preview"><img src={receiptQrUrl} alt="Clearance receipt verification QR code" /><span className="helper">Scan to verify this clearance receipt.</span></div>}{(previewAction === 'show_receipt' || project?.status === 'cleared') && <button className="button button-primary" style={{ marginTop: '1rem' }} onClick={generateReceipt}>{receipt ? 'Receipt issued' : 'Issue digital receipt'}</button>}</div> : <EmptyState icon={CircleDollarSign} title="No payment yet" copy="The fee is initialized securely on the server when you submit." />}</section></div></Workspace>;
}

function TeacherWorkspace({ profile, session, preview, onToast }) {
  const [projects, setProjects] = useState(preview ? demoReviewProjects : []);
  const [loading, setLoading] = useState(!preview);
  const [selected, setSelected] = useState(null);
  const [comment, setComment] = useState(preview && previewAction === 'open_review' ? 'Preview approval note for automated supervisor interaction coverage.' : '');
  useEffect(() => {
    if (preview || !session || !supabase) return undefined;
    supabase.from('projects').select('*, profiles!projects_student_id_fkey(full_name,matric,avatar_url)').eq('supervisor_id', session.user.id).order('created_at', { ascending: false }).then(({ data }) => setProjects((data || []).map(item => ({ ...item, author: item.profiles?.full_name, matric: item.profiles?.matric, dept: profile?.department, isDemo: false })))).finally(() => setLoading(false));
    return undefined;
  }, [preview, session, profile]);
  useEffect(() => { if (preview && previewAction === 'open_review') setSelected(projects[0]); }, [preview, projects]);
  const review = async decision => {
    if (!selected) return;
    if (preview || selected.isDemo) { onToast(decision === 'approve' ? 'Preview project approved.' : 'Preview revision request saved.'); setSelected(null); return; }
    try { await invoke('project-workflow', { action: 'supervisor_decision', project_id: selected.id, decision, comment }); setProjects(items => items.map(item => item.id === selected.id ? { ...item, status: decision === 'approve' ? 'supervisor_approved' : 'revision_requested' } : item)); setSelected(null); onToast(decision === 'approve' ? 'Project approved and routed to the library.' : 'Revision request sent to the student.'); } catch (error) { onToast(error.message); }
  };
  if (loading) return <PageSkeleton role="teacher" />;
  return <Workspace role="teacher" title="Supervisor review queue" subtitle="Review assigned research, preview private PDFs, and leave auditable decisions." sidebar={[[Users,'Assigned students',true],[FileCheck2,'Review history'],[Settings2,'Preferences']]}><MetricCards items={[["Awaiting review", projects.filter(item => item.status === 'supervisor_review').length, FileCheck2],["Revision requests", projects.filter(item => item.status === 'revision_requested').length, RefreshCw],["Approved", projects.filter(item => item.status === 'supervisor_approved').length, CheckCircle2],["Department", profile?.department || 'Computer Science', GraduationCap]]} /><section className="surface"><div className="surface-head"><div><h2>Assigned students</h2><p>Private files are opened through short-lived signed links.</p></div><span className="tag"><LockKeyhole size={12} />RLS protected</span></div>{projects.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Student</th><th>Degree</th><th>Project</th><th>Status</th><th>Action</th></tr></thead><tbody>{projects.map(item => <tr key={item.id}><td><strong>{item.author || 'Student'}</strong><br /><span className="helper">{item.matric || '—'}</span></td><td>{item.degree}</td><td>{item.title}</td><td><StatusChip status={item.status} /></td><td><button className="button button-primary button-small" onClick={() => { setSelected(item); setComment(''); }}>Review</button></td></tr>)}</tbody></table></div> : <EmptyState icon={Users} title="No assigned projects" copy="New submissions will appear here when they are assigned to you." />}</section><Modal open={Boolean(selected)} onClose={() => setSelected(null)} eyebrow="Supervisor review" title={selected?.title || ''} wide><div className="modal-body-grid"><div><div className="status-panel"><h3>{selected?.author || 'Student'}</h3><p className="helper">{selected?.matric} · {selected?.dept || 'Computer Science'} · {selected?.degree}</p><StatusChip status={selected?.status} /></div><p className="helper" style={{ marginTop: '1rem', lineHeight: 1.65 }}>{selected?.abstract}</p><div className="field" style={{ marginTop: '1rem' }}><label htmlFor="modal-review-comment">Decision comment</label><textarea id="modal-review-comment" value={comment} onChange={e => setComment(e.target.value)} placeholder="Add an approval note or explain the revision needed." /></div></div><div><p className="eyebrow">Private PDF preview</p>{selected?.isDemo ? <div className="empty-state surface"><FileText size={23} color="#065f46" /><h3>Preview unavailable in demo mode</h3><p>Real projects open through a five-minute signed storage URL.</p></div> : <PdfPreview path={selected?.file_path} />}</div></div><div className="modal-actions"><button className="button button-ghost" onClick={() => review('request_revision')}><PencilLine size={15} />Request revision</button><button className="button button-primary" onClick={() => review('approve')}><Check size={15} />Approve Project</button></div></Modal></Workspace>;
}

function PdfPreview({ path }) { const [url, setUrl] = useState(''); const [error, setError] = useState(''); useEffect(() => { if (!path) return undefined; signedPdfUrl(path).then(setUrl).catch(err => setError(err.message)); return undefined; }, [path]); if (error || !url) return <div className="empty-state surface"><FileText size={22} color="#065f46" /><h3>{error ? 'Preview unavailable' : 'Preparing secure preview...'}</h3><p>{error || 'Creating a short-lived private link.'}</p></div>; return <iframe className="pdf-frame" title="Private thesis PDF preview" src={url} />; }

function LibraryWorkspace({ session, preview, onToast }) {
  const [projects, setProjects] = useState(preview ? demoReviewProjects.filter(item => ['supervisor_approved','published'].includes(item.status)) : []);
  const [loading, setLoading] = useState(!preview);
  const [selected, setSelected] = useState(null);
  const [form, setForm] = useState({ shelf_number: 'KASU-CS-001', doi: '', comment: '' });
  const [qrUrl, setQrUrl] = useState('');
  useEffect(() => { if (preview && previewAction === 'open_catalog_record' && projects.length) { setSelected(projects[0]); setForm(current => ({ ...current, comment: 'Preview catalog note for automated library interaction coverage.' })); } }, [preview, projects]);
  useEffect(() => { if (preview || !session || !supabase) return undefined; supabase.from('projects').select('*, profiles!projects_student_id_fkey(full_name,matric)').in('status', ['supervisor_approved','library_review']).order('created_at', { ascending: false }).then(({ data }) => setProjects(data || [])).finally(() => setLoading(false)); return undefined; }, [preview, session]);
  useEffect(() => { let active = true; let objectUrl = ''; if (!selected?.qr_payload) { setQrUrl(''); return undefined; } fetchQrSvg(selected.qr_payload).then(url => { objectUrl = url; if (active) setQrUrl(url); }).catch(() => { if (active) setQrUrl(''); }); return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); }; }, [selected?.qr_payload]);
  const publish = async () => { if (!selected) return; if (preview || selected.isDemo) { onToast('Preview catalog record verified and published.'); setSelected(null); return; } try { const data = await invoke('project-workflow', { action: 'library_publish', project_id: selected.id, shelf_number: form.shelf_number, doi: form.doi, comment: form.comment }); setProjects(items => items.map(item => item.id === selected.id ? { ...item, ...data.project, status: 'published' } : item)); setSelected(data.project || { ...selected, status: 'published' }); onToast('Project published to the public catalog and QR code generated.'); } catch (error) { onToast(error.message); } };
  if (loading) return <PageSkeleton role="library" />;
  return <Workspace role="library" title="Library verification desk" subtitle="Verify metadata, assign shelf records, and publish approved research." sidebar={[[Library,'Verification queue',true],[BookOpen,'Public catalogue'],[QrCode,'QR labels'],[Archive,'Archive']]}><MetricCards items={[["Ready for verification", projects.filter(item => item.status === 'supervisor_approved').length, FileCheck2],["Published records", projects.filter(item => item.status === 'published').length, BookOpen],["Shelf labels", projects.length, QrCode],["Privacy", 'Private PDFs', LockKeyhole]]} /><section className="surface"><div className="surface-head"><div><h2>Verification queue</h2><p>Only supervisor-approved projects can enter the public catalogue.</p></div><span className="tag"><QrCode size={12} />QR ready</span></div>{projects.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Research</th><th>Author</th><th>Department</th><th>Status</th><th>Action</th></tr></thead><tbody>{projects.map(item => <tr key={item.id}><td><strong>{item.title}</strong><br /><span className="helper">{item.degree}</span></td><td>{item.author || item.profiles?.full_name || 'Student'}</td><td>{item.dept || 'Computer Science'}</td><td><StatusChip status={item.status} /></td><td><button className="button button-primary button-small" onClick={() => { setSelected(item); setForm({ shelf_number: `KASU-CS-${String(projects.indexOf(item) + 1).padStart(3,'0')}`, doi: '', comment: '' }); }}>Open record</button></td></tr>)}</tbody></table></div> : <EmptyState icon={Library} title="Queue is clear" copy="Supervisor-approved projects will arrive here for metadata verification." />}</section><Modal open={Boolean(selected)} onClose={() => setSelected(null)} eyebrow="Catalog record" title={selected?.title || ''} wide><div className="modal-body-grid"><div><div className="status-panel"><h3>Metadata verification</h3><p className="helper">{selected?.abstract}</p><StatusChip status={selected?.status} /></div><div className="form-grid" style={{ marginTop: '1rem' }}><div className="field"><label htmlFor="shelf-number">Shelf number</label><input id="shelf-number" value={form.shelf_number} onChange={e => setForm({ ...form, shelf_number: e.target.value })} /></div><div className="field"><label htmlFor="doi">DOI or catalogue ID</label><input id="doi" value={form.doi} onChange={e => setForm({ ...form, doi: e.target.value })} placeholder="Optional" /></div><div className="field full"><label htmlFor="lib-comment-input">Library note</label><textarea id="lib-comment-input" value={form.comment} onChange={e => setForm({ ...form, comment: e.target.value })} placeholder="Record the verification note." /></div></div></div><div className="surface"><p className="eyebrow">Publication checklist</p><div className="queue-list">{['Metadata complete','Abstract is discoverable','Private PDF remains protected','QR verification payload ready'].map(item => <div className="queue-item" key={item}><span className="helper">{item}</span><CheckCircle2 size={17} color="#059669" /></div>)}</div>{qrUrl && <div className="qr-preview"><img src={qrUrl} alt="Project verification QR code" /><span className="helper">Scan to verify this public catalog record.</span></div>}</div></div><div className="modal-actions"><button className="button button-ghost" onClick={() => setSelected(null)}>Cancel</button><button className="button button-primary" onClick={publish}><QrCode size={15} />{selected?.status === 'published' ? 'Refresh QR' : 'Verify &amp; Publish'}</button></div></Modal></Workspace>;
}

function AdminLivePanel({ profile, session, initialSection, onToast }) {
  const [section, setSection] = useState(initialSection || 'dashboard');
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState(null);
  const [students, setStudents] = useState([]);
  const [projects, setProjects] = useState([]);
  const [payments, setPayments] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [faculties, setFaculties] = useState([]);
  const [colleges, setColleges] = useState([]);
  const [institution, setInstitution] = useState(null);
  const [settings, setSettings] = useState(null);
  const [schedules, setSchedules] = useState([]);
  const [generatedReports, setGeneratedReports] = useState([]);
  const [saving, setSaving] = useState(false);
  const [newCollege, setNewCollege] = useState('');
  const [newFaculty, setNewFaculty] = useState({ name: '', college_id: '' });
  const [newDepartment, setNewDepartment] = useState({ name: '', code: '', faculty_id: '' });
  const [schedule, setSchedule] = useState({ report_type: 'project_lifecycle', frequency: 'monthly', email_recipients: '' });
  const institutionId = profile?.institution_id || institution?.id || null;

  const loadAdminData = useCallback(async () => {
    if (!supabase || !session) return;
    setLoading(true);
    const institutionQuery = profile?.institution_id
      ? supabase.from('institutions').select('*').eq('id', profile.institution_id).maybeSingle()
      : supabase.from('institutions').select('*').eq('slug', window.SPMS_DEFAULT_TENANT_SLUG || 'kasu').maybeSingle();
    const configQuery = profile?.institution_id ? supabase.from('system_configs').select('*').eq('institution_id', profile.institution_id).maybeSingle() : supabase.from('system_configs').select('*').maybeSingle();
    const scheduleQuery = profile?.institution_id ? supabase.from('report_schedules').select('*').eq('institution_id', profile.institution_id).order('created_at', { ascending: false }) : supabase.from('report_schedules').select('*').order('created_at', { ascending: false });
    const reportQuery = profile?.institution_id ? supabase.from('generated_reports').select('*').eq('institution_id', profile.institution_id).order('generated_at', { ascending: false }).limit(20) : supabase.from('generated_reports').select('*').order('generated_at', { ascending: false }).limit(20);
    const studentsQuery = supabase.from('profiles').select('id,full_name,email,matric,department,department_id,created_at').eq('role', 'student').order('created_at', { ascending: false }).limit(100);
    const projectQuery = supabase.from('projects').select('id,title,status,degree,created_at,updated_at,profiles!projects_student_id_fkey(full_name,matric),departments(name)').order('created_at', { ascending: false }).limit(100);
    const departmentQuery = supabase.from('departments').select('id,name,code,faculty_id,faculties(name)').order('name');
    const facultyQuery = supabase.from('faculties').select('id,name,college_id,colleges(name)').order('name');
    const collegeQuery = supabase.from('colleges').select('id,name').order('name');
    if (profile?.institution_id) {
      studentsQuery.eq('institution_id', profile.institution_id);
      projectQuery.eq('institution_id', profile.institution_id);
      departmentQuery.eq('institution_id', profile.institution_id);
      facultyQuery.eq('institution_id', profile.institution_id);
      collegeQuery.eq('institution_id', profile.institution_id);
    }
    try {
      const [overviewResult, studentsResult, projectResult, paymentResult, departmentResult, facultyResult, collegeResult, institutionResult, configResult, schedulesResult, reportResult] = await Promise.all([
        supabase.from('admin_overview').select('*').maybeSingle(),
        studentsQuery,
        projectQuery,
        supabase.from('payments').select('id,amount,currency,status,transaction_type,paystack_reference,created_at,paid_at,payer_id').order('created_at', { ascending: false }).limit(100),
        departmentQuery,
        facultyQuery,
        collegeQuery,
        institutionQuery,
        configQuery,
        scheduleQuery,
        reportQuery,
      ]);
      const reportRows = await Promise.all((reportResult.data || []).map(async item => {
        const signed = await supabase.storage.from('reports').createSignedUrl(item.file_path, 900);
        return signed.error ? item : { ...item, download_url: signed.data?.signedUrl || '' };
      }));
      setOverview(overviewResult.data || null);
      setStudents(studentsResult.data || []);
      setProjects(projectResult.data || []);
      setPayments(paymentResult.data || []);
      setDepartments(departmentResult.data || []);
      setFaculties(facultyResult.data || []);
      setColleges(collegeResult.data || []);
      setInstitution(institutionResult.data || null);
      setSettings(configResult.data || null);
      setSchedules(schedulesResult.data || []);
      setGeneratedReports(reportRows);
    } catch (error) {
      onToast(error.message || 'Admin data could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [onToast, profile, session]);

  useEffect(() => { loadAdminData(); }, [loadAdminData]);

  const updateSettings = event => setSettings(current => ({ ...(current || {}), [event.target.name]: event.target.value }));
  const updateInstitution = event => setInstitution(current => ({ ...(current || {}), [event.target.name]: event.target.value }));
  const saveSettings = async event => {
    event.preventDefault();
    if (!institutionId) { onToast('No institution is linked to this admin account.'); return; }
    setSaving(true);
    try {
      const { error: institutionError } = await supabase.from('institutions').update({ name: institution.name, short_name: institution.short_name, allowed_domains: String(institution.allowed_domains || '').split(/[\s,;]+/).filter(Boolean), primary_color: institution.primary_color, accent_color: institution.accent_color, updated_at: new Date().toISOString() }).eq('id', institutionId);
      if (institutionError) throw institutionError;
      const { error: configError } = await supabase.from('system_configs').upsert({ ...settings, institution_id: institutionId, clearance_fee_kobo: Number(settings.clearance_fee_kobo), download_fee_kobo: Number(settings.download_fee_kobo), institution_share_percent: Number(settings.institution_share_percent), provider_share_percent: Number(settings.provider_share_percent), updated_at: new Date().toISOString() }, { onConflict: 'institution_id' });
      if (configError) throw configError;
      onToast('Institution settings saved.');
    } catch (error) { onToast(error.message); }
    finally { setSaving(false); }
  };

  const addHierarchy = async (table, payload, reset) => {
    if (!institutionId || !payload.name.trim()) return;
    try {
      const { data, error } = await supabase.from(table).insert({ ...payload, institution_id: institutionId }).select('*').single();
      if (error) throw error;
      if (table === 'colleges') { setColleges(items => [...items, data].sort((a, b) => a.name.localeCompare(b.name))); setNewCollege(''); }
      if (table === 'faculties') { setFaculties(items => [...items, data].sort((a, b) => a.name.localeCompare(b.name))); setNewFaculty({ name: '', college_id: '' }); }
      if (table === 'departments') { setDepartments(items => [...items, data].sort((a, b) => a.name.localeCompare(b.name))); setNewDepartment({ name: '', code: '', faculty_id: '' }); }
      reset?.(); onToast(`${table.slice(0, -1)} added.`);
    } catch (error) { onToast(error.message); }
  };

  const createSchedule = async event => {
    event.preventDefault();
    if (!institutionId) { onToast('No institution is linked to this admin account.'); return; }
    try {
      const { data, error } = await supabase.from('report_schedules').insert({ institution_id: institutionId, created_by: session.user.id, report_type: schedule.report_type, frequency: schedule.frequency, metadata: { email_recipients: schedule.email_recipients.split(/[\s,;]+/).filter(Boolean) } }).select('*').single();
      if (error) throw error;
      setSchedules(items => [data, ...items]); setSchedule({ report_type: 'project_lifecycle', frequency: 'monthly', email_recipients: '' }); onToast('Report schedule created.');
    } catch (error) { onToast(error.message); }
  };

  const generateReport = async reportType => {
    try {
      const response = await runScheduledReport(reportType, []);
      const generated = response.generated?.[0];
      if (!generated?.file_path) throw new Error('Report was generated without a file path.');
      const signed = await supabase.storage.from('reports').createSignedUrl(generated.file_path, 900);
      if (signed.error) throw signed.error;
      setGeneratedReports(items => [{ ...generated, download_url: signed.data.signedUrl }, ...items]); onToast(`${reportType.replaceAll('_', ' ')} report is ready.`);
    } catch (error) { onToast(error.message); }
  };

  const runDue = async () => { try { const result = await runDueReports(); onToast(`${result.generated?.length || 0} scheduled report${result.generated?.length === 1 ? '' : 's'} processed.`); await loadAdminData(); } catch (error) { onToast(error.message); } };
  const successfulPayments = payments.filter(item => item.status === 'success');
  const workflowValues = ['submitted', 'supervisor_review', 'revision_requested', 'supervisor_approved', 'library_review', 'published', 'cleared'].map(status => [status.replaceAll('_', ' '), projects.filter(item => item.status === status).length]);
  const revenue = successfulPayments.reduce((total, item) => total + Number(item.amount || 0), 0);
  const institutionShare = Number(settings?.institution_share_percent || 50);
  const nav = [[Archive, 'Dashboard', 'dashboard'], [Users, 'Students', 'students'], [UserCheck, 'Supervisors', 'supervisors'], [Library, 'Departments', 'departments'], [FileText, 'Uploads', 'uploads'], [CircleDollarSign, 'Payments', 'payments'], [FileCheck2, 'Reports', 'reports'], [Settings2, 'Settings', 'settings']];
  const metrics = [["Total students", overview?.total_students ?? students.length, Users], ["Total revenue", formatNaira(overview?.total_revenue_kobo ?? revenue), CircleDollarSign], ["Total uploads", overview?.total_projects ?? projects.length, FileText], ["Pending approvals", (overview?.pending_supervisor_review || 0) + (overview?.pending_library_review || 0), FileCheck2]];

  if (loading) return <PageSkeleton role="admin" />;
  return <Workspace role="admin" title="Analytics hub" subtitle="Live operations for academic clearance, finance, and institutional governance." sidebar={nav.map(([Icon, label, id]) => [Icon, label, section === id, () => setSection(id)])}>
    <MetricCards items={metrics} />
    {section === 'dashboard' && <div className="workspace-grid"><AnalyticsCard title="Workflow funnel" copy="Current project counts across every clearance stage." values={workflowValues} /><AnalyticsCard title="Revenue split" copy="Successful Paystack transactions reconciled by configured share." values={[["Institution share", institutionShare], ["SPMS provider share", 100 - institutionShare], ["Successful transactions", successfulPayments.length]]} accent /><AnalyticsCard title="Monthly revenue" copy="Latest recorded payment volume." values={[["This month", successfulPayments.filter(item => item.created_at && new Date(item.created_at).getMonth() === new Date().getMonth()).reduce((total, item) => total + Number(item.amount || 0), 0) / 100], ["All time", revenue / 100]]} accent /><AnalyticsCard title="Publication progress" copy="Approved catalog records and cleared receipts." values={[["Published", overview?.published_projects || projects.filter(item => item.status === 'published').length], ["Cleared", projects.filter(item => item.status === 'cleared').length]]} /></div>}
    {section === 'students' && <section className="surface"><SectionHeader eyebrow="Student directory" title="Registered students" copy="Searchable student records connected to project ownership and department mapping." /><DataTable columns={['Name', 'Matric', 'Email', 'Department', 'Joined']} rows={students.map(item => [item.full_name || 'Unnamed student', item.matric || '—', item.email || '—', item.department || 'Unassigned', displayDate(item.created_at)])} empty="No student profiles found." /></section>}
    {section === 'supervisors' && <AdminSupervisorQueue profile={profile} onToast={onToast} />}
    {section === 'departments' && <HierarchyManager colleges={colleges} faculties={faculties} departments={departments} newCollege={newCollege} setNewCollege={setNewCollege} newFaculty={newFaculty} setNewFaculty={setNewFaculty} newDepartment={newDepartment} setNewDepartment={setNewDepartment} addHierarchy={addHierarchy} />}
    {section === 'uploads' && <section className="surface"><SectionHeader eyebrow="Project register" title="All thesis uploads" copy="Monitor status, student ownership, academic level, and submission timestamps." /><DataTable columns={['Project', 'Student', 'Degree', 'Status', 'Submitted']} rows={projects.map(item => [item.title, item.profiles?.full_name || 'Student', item.degree || '—', <StatusChip status={item.status} key={`${item.id}-status`} />, displayDate(item.created_at)])} empty="No project uploads found." /></section>}
    {section === 'payments' && <section className="surface"><SectionHeader eyebrow="Finance evidence" title="Payment ledger" copy="Successful and pending Paystack transactions with references for reconciliation." /><DataTable columns={['Reference', 'Type', 'Amount', 'Status', 'Created']} rows={payments.map(item => [item.paystack_reference || '—', item.transaction_type?.replaceAll('_', ' ') || '—', formatNaira(item.amount), item.status || '—', displayDate(item.created_at)])} empty="No payment records found." /></section>}
    {section === 'reports' && <AdminReports schedules={schedules} generatedReports={generatedReports} schedule={schedule} setSchedule={setSchedule} createSchedule={createSchedule} generateReport={generateReport} runDue={runDue} />}
    {section === 'settings' && <AdminSettings institution={institution} settings={settings} onInstitutionChange={updateInstitution} onSettingsChange={updateSettings} onSave={saveSettings} saving={saving} />}
  </Workspace>;
}

function DataTable({ columns, rows, empty }) { return rows.length ? <div className="table-wrap"><table className="data-table"><thead><tr>{columns.map(column => <th key={column}>{column}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div> : <EmptyState icon={Archive} title={empty} copy="New records will appear here as the workflow is used." />; }

function HierarchyManager({ colleges, faculties, departments, newCollege, setNewCollege, newFaculty, setNewFaculty, newDepartment, setNewDepartment, addHierarchy }) {
  return <section className="surface"><SectionHeader eyebrow="Academic structure" title="Colleges, faculties, and departments" copy="Maintain the academic hierarchy used for student routing, supervisor matching, and reports." /><div className="hierarchy-forms"><form className="inline-form" onSubmit={event => { event.preventDefault(); addHierarchy('colleges', { name: newCollege }); }}><label htmlFor="new-college">College</label><input id="new-college" value={newCollege} onChange={event => setNewCollege(event.target.value)} placeholder="College name" /><button className="button button-primary button-small"><Plus size={14} />Add</button></form><form className="inline-form" onSubmit={event => { event.preventDefault(); addHierarchy('faculties', newFaculty); }}><label htmlFor="new-faculty">Faculty</label><input id="new-faculty" value={newFaculty.name} onChange={event => setNewFaculty({ ...newFaculty, name: event.target.value })} placeholder="Faculty name" /><select value={newFaculty.college_id} onChange={event => setNewFaculty({ ...newFaculty, college_id: event.target.value })} aria-label="College for new faculty"><option value="">College</option>{colleges.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select><button className="button button-primary button-small"><Plus size={14} />Add</button></form><form className="inline-form" onSubmit={event => { event.preventDefault(); addHierarchy('departments', newDepartment); }}><label htmlFor="new-department">Department</label><input id="new-department" value={newDepartment.name} onChange={event => setNewDepartment({ ...newDepartment, name: event.target.value })} placeholder="Department name" /><input value={newDepartment.code} onChange={event => setNewDepartment({ ...newDepartment, code: event.target.value })} placeholder="Code" aria-label="Department code" /><select value={newDepartment.faculty_id} onChange={event => setNewDepartment({ ...newDepartment, faculty_id: event.target.value })} aria-label="Faculty for new department"><option value="">Faculty</option>{faculties.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select><button className="button button-primary button-small"><Plus size={14} />Add</button></form></div><div className="hierarchy-grid"><div><h3>Colleges</h3>{colleges.map(item => <div className="queue-item" key={item.id}><span>{item.name}</span></div>)}</div><div><h3>Faculties</h3>{faculties.map(item => <div className="queue-item" key={item.id}><span>{item.name}</span><small>{item.colleges?.name || 'College not mapped'}</small></div>)}</div><div><h3>Departments</h3>{departments.map(item => <div className="queue-item" key={item.id}><span>{item.name}</span><small>{item.code || 'No code'} · {item.faculties?.name || 'Faculty not mapped'}</small></div>)}</div></div></section>;
}

function AdminSupervisorQueue({ profile, onToast }) { const [queue, setQueue] = useState([]); const [supervisors, setSupervisors] = useState([]); const [loading, setLoading] = useState(true); useEffect(() => { const projectsQuery = supabase.from('projects').select('id,title,status,profiles!projects_student_id_fkey(full_name,matric,department)').is('supervisor_id', null).in('status', ['submitted', 'supervisor_review']); const supervisorsQuery = supabase.from('profiles').select('id,full_name,department').eq('role', 'teacher'); if (profile?.institution_id) { projectsQuery.eq('institution_id', profile.institution_id); supervisorsQuery.eq('institution_id', profile.institution_id); } Promise.all([projectsQuery, supervisorsQuery]).then(([projectsResult, supervisorsResult]) => { setQueue((projectsResult.data || []).map(item => ({ ...item, author: item.profiles?.full_name, matric: item.profiles?.matric, dept: item.profiles?.department }))); setSupervisors(supervisorsResult.data || []); }).catch(error => onToast(error.message)).finally(() => setLoading(false)); }, [profile, onToast]); const assign = async (projectId, supervisorId) => { try { await invoke('project-workflow', { action: 'assign_supervisor', project_id: projectId, supervisor_id: supervisorId }); setQueue(items => items.filter(item => item.id !== projectId)); onToast('Supervisor assigned and notification sent.'); } catch (error) { onToast(error.message); } }; if (loading) return <PageSkeleton role="admin" />; return <section className="surface" id="admin-supervisors"><SectionHeader eyebrow="Supervisor management" title="Unassigned Review Queue" copy="Resolve submissions that could not be automatically matched to an eligible supervisor." action={<span className="tag"><UserCheck size={12} />Protected action</span>} />{queue.length ? <div className="queue-list">{queue.map(item => <AssignmentRow item={item} supervisors={supervisors} onAssign={assign} key={item.id} />)}</div> : <EmptyState icon={UserCheck} title="Assignment queue is clear" copy="Every eligible submission currently has a supervisor." />}</section>; }

function AdminReports({ schedules, generatedReports, schedule, setSchedule, createSchedule, generateReport, runDue }) { return <section className="surface" id="admin-reports"><SectionHeader eyebrow="Reporting" title="Scheduled reporting controls" copy="Generate exports, maintain recurring delivery schedules, and download private report artifacts." action={<div className="card-actions"><button className="button button-primary button-small" onClick={() => generateReport('project_lifecycle')}><Download size={15} />Generate lifecycle</button><button className="button button-ghost button-small" onClick={runDue}><RefreshCw size={15} />Run due</button></div>} /><div className="workspace-grid"><form className="surface form-grid" onSubmit={createSchedule}><div className="field"><label htmlFor="report-type">Report type</label><select id="report-type" value={schedule.report_type} onChange={event => setSchedule({ ...schedule, report_type: event.target.value })}><option value="student_register">Student register</option><option value="project_lifecycle">Project lifecycle</option><option value="financial">Financial</option><option value="archive">Archive</option></select></div><div className="field"><label htmlFor="report-frequency">Frequency</label><select id="report-frequency" value={schedule.frequency} onChange={event => setSchedule({ ...schedule, frequency: event.target.value })}><option>daily</option><option>weekly</option><option>monthly</option></select></div><div className="field full"><label htmlFor="report-recipients">Email recipients</label><input id="report-recipients" value={schedule.email_recipients} onChange={event => setSchedule({ ...schedule, email_recipients: event.target.value })} placeholder="registry@kasu.edu.ng, library@kasu.edu.ng" /><span className="helper">Recipients are stored in the schedule metadata and receive private signed links when email delivery is configured.</span></div><button className="button button-primary full"><Save size={15} />Create schedule</button></form><div className="surface"><div className="surface-head"><div><h2>Generated reports</h2><p>Private CSV files expire through signed storage links.</p></div></div>{generatedReports.length ? <div className="queue-list">{generatedReports.map(item => <div className="queue-item" key={item.id}><div><strong>{item.report_type.replaceAll('_', ' ')}</strong><small>{item.row_count} rows · {displayDate(item.generated_at)}</small></div>{item.download_url ? <a className="button button-ghost button-small" href={item.download_url} target="_blank" rel="noreferrer"><Download size={14} />Download</a> : <span className="tag">Private file</span>}</div>)}</div> : <EmptyState icon={FileCheck2} title="No reports generated" copy="Run a report to create the first private artifact." />}</div></div><div className="surface" style={{ marginTop: '1rem' }}><div className="surface-head"><div><h2>Active schedules</h2><p>{schedules.length} configured schedule{schedules.length === 1 ? '' : 's'}.</p></div></div><DataTable columns={['Report', 'Frequency', 'Next run', 'Status']} rows={schedules.map(item => [item.report_type.replaceAll('_', ' '), item.frequency, displayDate(item.next_run_at), item.is_active ? 'Active' : 'Paused'])} empty="No schedules configured." /></div></section>; }

function AdminSettings({ institution, settings, onInstitutionChange, onSettingsChange, onSave, saving }) { if (!institution || !settings) return <EmptyState icon={Settings2} title="Settings unavailable" copy="The institution configuration could not be loaded for this account." />; return <section className="surface"><SectionHeader eyebrow="White-label controls" title="Institution settings" copy="Configure branding, fees, payment splits, storage limits, and tenant domains." /><form className="form-grid" onSubmit={onSave}><div className="field"><label htmlFor="institution-name">Institution name</label><input id="institution-name" name="name" value={institution.name || ''} onChange={onInstitutionChange} /></div><div className="field"><label htmlFor="institution-short-name">Short name</label><input id="institution-short-name" name="short_name" value={institution.short_name || ''} onChange={onInstitutionChange} /></div><div className="field full"><label htmlFor="institution-domains">Allowed domains</label><input id="institution-domains" name="allowed_domains" value={Array.isArray(institution.allowed_domains) ? institution.allowed_domains.join(', ') : institution.allowed_domains || ''} onChange={onInstitutionChange} /><span className="helper">Separate custom domains with commas. Tenant resolution checks this list before the default slug.</span></div><div className="field"><label htmlFor="clearance-fee">Clearance fee (kobo)</label><input id="clearance-fee" name="clearance_fee_kobo" type="number" min="0" value={settings.clearance_fee_kobo ?? 200000} onChange={onSettingsChange} /></div><div className="field"><label htmlFor="download-fee">Repository download fee (kobo)</label><input id="download-fee" name="download_fee_kobo" type="number" min="0" value={settings.download_fee_kobo ?? 50000} onChange={onSettingsChange} /></div><div className="field"><label htmlFor="institution-share">Institution share (%)</label><input id="institution-share" name="institution_share_percent" type="number" min="0" max="100" step="0.01" value={settings.institution_share_percent ?? 50} onChange={onSettingsChange} /></div><div className="field"><label htmlFor="provider-share">Provider share (%)</label><input id="provider-share" name="provider_share_percent" type="number" min="0" max="100" step="0.01" value={settings.provider_share_percent ?? 50} onChange={onSettingsChange} /></div><div className="field"><label htmlFor="primary-color">Primary color</label><input id="primary-color" name="primary_color" type="color" value={institution.primary_color || '#065F46'} onChange={onInstitutionChange} /></div><div className="field"><label htmlFor="accent-color">Accent color</label><input id="accent-color" name="accent_color" type="color" value={institution.accent_color || '#F59E0B'} onChange={onInstitutionChange} /></div><div className="modal-actions full"><button className="button button-primary" disabled={saving}><Save size={15} />{saving ? 'Saving...' : 'Save settings'}</button></div></form></section>; }

function AdminWorkspace({ profile, session, preview, onToast }) {
  const [section, setSection] = useState(previewAction === 'open_reports' ? 'reports' : previewAction === 'open_assignments' ? 'supervisors' : 'dashboard');
  const [queue, setQueue] = useState(preview ? [{ id: 'preview-project', title: 'Web-Based E-Voting System', author: 'Musa Abdullahi', matric: 'KASU/SCI/20/123', dept: 'Computer Science' }] : []);
  const [supervisors, setSupervisors] = useState(preview ? [{ id: 'preview-teacher', full_name: 'Dr. Sani Musa', department: 'Computer Science' }] : []);
  const [loading, setLoading] = useState(!preview);
  const [report, setReport] = useState(preview ? { file_path: 'preview/project-lifecycle-preview.csv', report_type: 'project_lifecycle', row_count: 4 } : null);
  const [reportBusy, setReportBusy] = useState(false);
  useEffect(() => { if (preview || !session || !supabase) return undefined; Promise.all([supabase.from('projects').select('id,title,status,profiles!projects_student_id_fkey(full_name,matric)').is('supervisor_id', null).in('status', ['submitted','supervisor_review']), supabase.from('profiles').select('id,full_name,department').eq('role','teacher')]).then(([projectsResult, teachersResult]) => { setQueue((projectsResult.data || []).map(item => ({ ...item, author: item.profiles?.full_name, matric: item.profiles?.matric }))); setSupervisors(teachersResult.data || []); }).finally(() => setLoading(false)); return undefined; }, [preview, session]);
  const assign = async (projectId, supervisorId) => { if (preview) { onToast('Preview supervisor assignment completed.'); return; } try { await invoke('project-workflow', { action: 'assign_supervisor', project_id: projectId, supervisor_id: supervisorId }); setQueue(items => items.filter(item => item.id !== projectId)); onToast('Supervisor assigned and notification sent.'); } catch (error) { onToast(error.message); } };
  const generateReport = async () => {
    if (preview) { setReport({ file_path: 'preview/project-lifecycle-preview.csv', report_type: 'project_lifecycle', row_count: 4 }); onToast('Preview reports loaded for workflow export.'); return; }
    setReportBusy(true);
    try {
      const response = await runScheduledReport('project_lifecycle', []);
      const generated = response.generated?.[0];
      if (!generated?.file_path) throw new Error('Report was generated without a file path.');
      const signed = await supabase.storage.from('reports').createSignedUrl(generated.file_path, 900);
      if (signed.error) throw signed.error;
      setReport({ ...generated, download_url: signed.data.signedUrl }); onToast('Project lifecycle report is ready.');
    } catch (error) { onToast(error.message); }
    finally { setReportBusy(false); }
  };
  const runScheduledReports = async () => { if (preview) { onToast('Preview schedule checked.'); return; } try { const response = await runDueReports(); onToast(`${response.generated?.length || 0} scheduled report${response.generated?.length === 1 ? '' : 's'} processed.`); } catch (error) { onToast(error.message); } };
  if (loading) return <PageSkeleton role="admin" />;
  if (!preview) return <AdminLivePanel profile={profile} session={session} initialSection={section} onToast={onToast} />;
  const nav = [[Archive,'Dashboard','dashboard'],[Users,'Students','students'],[UserCheck,'Supervisors','supervisors'],[Library,'Departments','departments'],[FileText,'Uploads','uploads'],[CircleDollarSign,'Payments','payments'],[FileCheck2,'Reports','reports'],[Settings2,'Settings','settings']];
  return <Workspace role="admin" title="Analytics hub" subtitle="A compact operations view for academic clearance, finance, and institutional governance." sidebar={nav.map(([Icon,label,id]) => [Icon,label,section === id,() => setSection(id)])}><MetricCards items={[["Total students", demoStats.students, Users],["Total revenue", '₦8.43m', CircleDollarSign],["Total uploads", demoStats.submitted, FileText],["Pending approvals", '216', FileCheck2]]} />{section === 'dashboard' && <div className="workspace-grid"><AnalyticsCard title="Workflow funnel" copy="Live status distribution across the clearance pipeline." values={[["Submitted",920],["Supervisor review",780],["Library review",650],["Cleared",612]]} /><AnalyticsCard title="Revenue split" copy="Institution and provider shares reconcile against Paystack records." values={[["Institution share",80],["SPMS provider share",20],["Legacy / unallocated",4]]} accent /></div>}{section === 'supervisors' && <section className="surface" id="admin-supervisors"><SectionHeader eyebrow="Supervisor management" title="Unassigned Review Queue" copy="Resolve submissions that could not be automatically matched to an eligible supervisor." action={<span className="tag"><UserCheck size={12} />Protected action</span>} />{queue.length ? <div className="queue-list">{queue.map(item => <AssignmentRow item={item} supervisors={supervisors} onAssign={assign} key={item.id} />)}</div> : <EmptyState icon={UserCheck} title="Assignment queue is clear" copy="Every eligible submission currently has a supervisor." />}</section>}{section === 'reports' && <section className="surface" id="admin-reports"><SectionHeader eyebrow="Reporting" title="Scheduled reporting controls" copy="Export operational, lifecycle, financial, and archive evidence for registry review." action={<button className="button button-primary button-small" onClick={generateReport} disabled={reportBusy}><Download size={15} />{reportBusy ? 'Generating...' : 'Generate report'}</button>} /><div className="workspace-grid"><div className="surface"><h3>Project lifecycle</h3><p className="helper" style={{ marginTop: '.5rem' }}>Monthly workflow export with audit events and status changes.</p><span className="tag" style={{ marginTop: '1rem' }}>{report?.file_path?.split('/').pop() || 'No report generated'}</span>{report?.download_url && <a className="button button-ghost button-small" style={{ marginTop: '1rem' }} href={report.download_url} target="_blank" rel="noreferrer"><Download size={14} />Download signed report</a>}</div><div className="surface"><h3>Delivery schedule</h3><p className="helper" style={{ marginTop: '.5rem' }}>Private signed links can be delivered to configured recipients.</p><button className="button button-ghost button-small" onClick={runScheduledReports}><RefreshCw size={14} />Run due schedules</button></div></div></section>}{!['dashboard','supervisors','reports'].includes(section) && <section className="surface"><EmptyState icon={Settings2} title={`${section[0].toUpperCase()}${section.slice(1)} operations`} copy="This workspace is connected to the SPMS role shell and ready for its data view." /></section>}<div className="sidebar-tabs" aria-label="Admin sections">{nav.map(([Icon,label,id]) => <button key={id} className={section === id ? 'active' : ''} onClick={() => setSection(id)}><Icon size={14} />{label}</button>)}</div></Workspace>;
}

function AssignmentRow({ item, supervisors, onAssign }) { const [selected, setSelected] = useState(''); return <div className="queue-item"><div><h3>{item.title}</h3><p>{item.author || 'Student'} · {item.matric || '—'} · {item.dept || 'Department needs mapping'}</p></div><div style={{ display: 'flex', gap: '.5rem', width: 'min(460px,100%)' }}><select className="glass-input" aria-label={`Supervisor for ${item.title}`} value={selected} onChange={e => setSelected(e.target.value)}><option value="">Select supervisor</option>{supervisors.map(person => <option value={person.id} key={person.id}>{person.full_name} · {person.department || 'Institution-wide'}</option>)}</select><button className="button button-primary button-small" disabled={!selected} onClick={() => onAssign(item.id, selected)}><UserCheck size={14} />Assign</button></div></div>; }
function AnalyticsCard({ title, copy, values, accent = false }) { const max = Math.max(...values.map(([,value]) => value)); return <section className="surface"><div className="surface-head"><div><h2>{title}</h2><p>{copy}</p></div><span className="tag">{accent ? 'Reconciliation' : 'Live status'}</span></div><div className="queue-list">{values.map(([label,value]) => <div key={label}><div style={{ display: 'flex', justifyContent: 'space-between', color: '#40536b', fontSize: '.75rem', fontWeight: 700, marginBottom: '.4rem' }}><span>{label}</span><span>{accent ? `${value}%` : value}</span></div><div className="progress-track"><div className="progress-fill" style={{ width: `${(value / max) * 100}%`, background: accent ? '#f59e0b' : '#065f46' }} /></div></div>)}</div></section>; }
