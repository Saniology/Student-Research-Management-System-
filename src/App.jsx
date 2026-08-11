import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Archive, ArrowRight, BookOpen, Check, CheckCircle2, CircleDollarSign, Download, FileCheck2, FileText, GraduationCap, Library, LockKeyhole, PencilLine, Plus, QrCode, RefreshCw, Save, Search, Send, Settings2, ShieldCheck, UserCheck, UserPlus, Users, XCircle } from 'lucide-react';
import { AppShell, EmptyState, SearchBox, SectionHeader } from './components/AppShell';
import { Modal } from './components/Modal';
import { PageSkeleton } from './components/Skeleton';
import { StatusChip } from './components/StatusChip';
import { config, fallbackTenant, invoke, loadProfile, loadSystemConfig, loadTenant, signedPdfUrl, supabase } from './lib/supabase';
import { fetchQrSvg, issueReceipt, lookupVerification, retryPaymentVerification, runDueReports, runScheduledReport } from './lib/contracts';
import { demoProjects, demoReviewProjects, demoStats } from './data/demo';
import './styles.css';

const previewParams = new URLSearchParams(window.location.search);
const isLocalHost = hostname => ['localhost', '127.0.0.1', '0.0.0.0'].includes(hostname);
const isRolePreviewAllowed = () => isLocalHost(window.location.hostname) && ['student', 'teacher', 'library', 'admin'].includes(previewParams.get('preview_role'));
const previewRole = isRolePreviewAllowed() ? previewParams.get('preview_role') : '';
const previewAction = previewParams.get('preview_action') || '';

function formatNaira(kobo = 0) { return new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 }).format(Number(kobo) / 100); }
function displayDate(value) { return value ? new Date(value).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; }
const DEFAULT_MAX_PDF_BYTES = 100 * 1024 * 1024;
function resumePaystackPayment(payment, handlers) {
  if (typeof window.PaystackPop !== 'function') throw new Error('Paystack could not load. Refresh the page and try again.');
  const checkout = new window.PaystackPop();
  if (typeof checkout.resumeTransaction !== 'function') throw new Error('This Paystack checkout version is unavailable. Refresh the page and try again.');
  checkout.resumeTransaction(payment.access_code, handlers);
}
function validateThesisFile(file, maxBytes = DEFAULT_MAX_PDF_BYTES) {
  if (!file) return 'Choose the thesis PDF before continuing.';
  if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) return 'Only PDF files are accepted.';
  if (file.size > maxBytes) return `The PDF must be smaller than ${Math.round(maxBytes / (1024 * 1024))} MB.`;
  return '';
}

export default function App() {
  const [tenant, setTenant] = useState(fallbackTenant);
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [view, setView] = useState(previewRole || 'landing');
  const [booting, setBooting] = useState(true);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState('login');
  const [pendingDownloadProject, setPendingDownloadProject] = useState(null);
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

  const markNotificationsRead = useCallback(async () => {
    if (!notifications.length) {
      notify('You are all caught up.');
      return;
    }
    if (supabase && session && !previewRole) {
      const ids = notifications.map(item => item.id).filter(Boolean);
      if (ids.length) {
        const { error } = await supabase
          .from('notifications')
          .update({ read_at: new Date().toISOString() })
          .in('id', ids)
          .eq('recipient_id', session.user.id);
        if (error) {
          notify(error.message);
          return;
        }
      }
    }
    const count = notifications.length;
    setNotifications([]);
    notify(`${count} notification${count === 1 ? '' : 's'} marked as read.`);
  }, [notifications, notify, session]);

  const goHome = () => setView('landing');
  const openLogin = () => { setAuthMode('login'); setAuthOpen(true); };
  const logout = async () => { if (supabase) await supabase.auth.signOut(); setSession(null); setProfile(null); setView('landing'); notify('You have been signed out.'); };
  const enterWorkspace = nextRole => { setView(nextRole); setAuthOpen(false); };
  const continueRepositoryDownload = useCallback(async project => {
    if (!session) return;
    if (previewRole || project?.id?.startsWith('demo-')) { notify('Preview download is protected by the repository payment gate.'); return; }
    try {
      const access = await invoke('repository-access', { action: 'get_download_url', project_id: project.id });
      if (access.signed_url) { window.open(access.signed_url, '_blank', 'noopener'); return; }
      const payment = await invoke('repository-access', { action: 'initialize_download', project_id: project.id });
      resumePaystackPayment(payment, {
        onSuccess: async response => {
          try {
            const reference = response?.reference || response?.trxref || payment.reference;
            const result = await invoke('repository-access', { action: 'verify_download', project_id: project.id, reference });
            if (result.signed_url) window.open(result.signed_url, '_blank', 'noopener');
            notify('Watermarked download unlocked for five minutes.');
          } catch (error) {
            notify(`Payment completed, but the download could not be unlocked: ${error.message}`);
          }
        },
        onCancel: () => notify('Download payment was cancelled.'),
        onError: error => notify(error?.message || 'Paystack could not open.'),
      });
    } catch (error) { notify(error.message); }
  }, [notify, session]);
  const handleDownload = project => {
    if (!session) {
      setPendingDownloadProject(project);
      setAuthMode('signup');
      setAuthOpen(true);
      notify('Create an account with your matric number and school email to download this thesis.');
      return;
    }
    continueRepositoryDownload(project);
  };
  useEffect(() => {
    if (!session || !profile || !pendingDownloadProject || previewRole) return;
    const project = pendingDownloadProject;
    setPendingDownloadProject(null);
    continueRepositoryDownload(project);
  }, [continueRepositoryDownload, pendingDownloadProject, profile, session]);

  if (booting) return <><AppShell tenant={tenant} onHome={goHome} onLogin={openLogin}><PageSkeleton role="landing" /></AppShell></>;
  return <AppShell tenant={tenant} role={role} onHome={goHome} onLogin={openLogin} onLogout={logout} notificationCount={notifications.length} onNotifications={markNotificationsRead}>
    {view === 'landing' && <Landing tenant={tenant} session={session} onLogin={openLogin} onWorkspace={() => role ? enterWorkspace(role) : openLogin()} onDownload={handleDownload} configError={!config.valid && !previewRole} />}
    {view === 'student' && <StudentWorkspace profile={profile} session={session} preview={Boolean(previewRole)} onToast={notify} />}
    {view === 'teacher' && <TeacherWorkspace profile={profile} session={session} preview={Boolean(previewRole)} onToast={notify} />}
    {view === 'library' && <LibraryWorkspace profile={profile} session={session} preview={Boolean(previewRole)} onToast={notify} />}
    {view === 'admin' && <AdminWorkspace profile={profile} session={session} preview={Boolean(previewRole)} onToast={notify} />}
    <AuthModal tenant={tenant} open={authOpen} mode={authMode} onClose={() => setAuthOpen(false)} onModeChange={setAuthMode} onSuccess={(nextSession, nextProfile) => { setSession(nextSession); setProfile(nextProfile); enterWorkspace(nextProfile.role); }} onToast={notify} />
    {toast && <div className="toast" role="status">{toast}</div>}
  </AppShell>;
}

function Landing({ tenant, session, onLogin, onWorkspace, onDownload, configError }) {
  const [query, setQuery] = useState('');
  const [projects, setProjects] = useState(config.valid ? [] : demoProjects);
  const [impact, setImpact] = useState(config.valid ? { students: '—', submitted: '—', approved: '—', departments: '—' } : demoStats);
  const [abstractProject, setAbstractProject] = useState(null);
  useEffect(() => {
    if (!supabase) return undefined;
    let active = true;
    const catalogQuery = supabase.from('public_catalog').select('id, title, department_name, course_name, degree, abstract, published_at, project_id, institution_id').order('published_at', { ascending: false }).limit(12);
    const publishedCountQuery = supabase.from('public_catalog').select('id', { count: 'exact', head: true });
    const departmentQuery = supabase.from('public_catalog').select('department_id');
    if (tenant?.id) {
      catalogQuery.eq('institution_id', tenant.id);
      publishedCountQuery.eq('institution_id', tenant.id);
      departmentQuery.eq('institution_id', tenant.id);
    }
    Promise.all([catalogQuery, publishedCountQuery, departmentQuery]).then(([catalogResult, publishedResult, departmentResult]) => {
      if (!active) return;
      if (catalogResult.error) throw catalogResult.error;
      setProjects((catalogResult.data || []).map(item => ({ ...item, author: 'Anonymized researcher', dept: item.department_name, course: item.course_name, status: 'published' })));
      const departments = new Set((departmentResult.data || []).map(item => item.department_id).filter(Boolean));
      setImpact({ students: '—', submitted: '—', approved: publishedResult.count ?? 0, departments: departments.size || '—' });
    }).catch(() => { if (active) { setProjects([]); setImpact({ students: '—', submitted: '—', approved: '—', departments: '—' }); } });
    return () => { active = false; };
  }, [tenant?.id]);
  const visibleProjects = projects.filter(project => [project.title, project.author, project.dept, project.course, project.degree].join(' ').toLowerCase().includes(query.toLowerCase()));
  return <div className="blueprint">
    {configError && <div className="config-alert" id="app-config-error" role="alert"><Settings2 size={16} /><span>Browser configuration is incomplete. Add the public Supabase URL, anon key, and Paystack public key in <code>js/config.js</code> before signing in or submitting.</span></div>}
    <section className="hero"><div className="hero-grid"><div><p className="eyebrow">{tenant.name || 'Kaduna State University'}</p><h1>{tenant.short_name || 'KASU'} <span>SPMS</span></h1><p className="hero-copy">A single workspace for final-year submissions, supervisor review, library publishing, verified receipts, Paystack reconciliation, and controlled repository access.</p><div className="hero-actions"><button className="button button-accent" onClick={onLogin}><LogInIcon />Login to portal</button><button className="button button-ghost" onClick={() => document.getElementById('repository')?.scrollIntoView({ behavior: 'smooth' })}><Search size={16} />Browse repository</button>{session ? <button className="button button-ghost" onClick={onWorkspace}><ArrowRight size={16} />Open workspace</button> : <button className="button button-ghost" onClick={onLogin}>Create account</button>}</div></div><OperationsBoard /></div></section>
    <div className="trust-band"><ShieldCheck size={15} /> Simple, auditable workflow from submission to digital clearance</div>
    <section className="timeline-section"><div className="center-heading"><p className="eyebrow">One connected process</p><h2>The Clearance Process</h2><p className="muted">Every stage is visible, accountable, and connected from the first student submission to final digital clearance.</p></div><div className="timeline">{[[GraduationCap,'Student Login'],[FileText,'Upload Thesis'],[UserCheck,'Supervisor Approval'],[Library,'Library Verification'],[CheckCircle2,'Clearance Completed']].map(([Icon, label]) => <div className="timeline-step" key={label}><span className="timeline-icon"><Icon size={19} /></span><strong>{label}</strong></div>)}</div></section>
    <section className="impact-section"><div className="center-heading"><p className="eyebrow">Institutional signal</p><h2>Institutional Impact</h2></div><div className="metrics-grid">{[[impact.students,'Students'],[impact.submitted,'Projects submitted'],[impact.approved,'Approved'],[impact.departments,'Departments']].map(([value,label]) => <div className="impact-metric" key={label}><strong>{value}</strong><span>{label}</span></div>)}</div></section>
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
function ProjectCard({ project, onAbstract, onDownload }) { const downloadProject = project.project_id ? { ...project, id: project.project_id } : project; return <article className="project-card"><div className="project-meta"><span className="tag">{project.degree || 'Research'}</span><span>{project.course || project.dept || 'Institution'}</span></div><h3>{project.title}</h3><p>{project.abstract}</p><div className="card-actions"><button className="button button-ghost button-small" onClick={onAbstract}>View abstract</button><button className="button button-primary button-small" onClick={() => onDownload(downloadProject)}><Download size={14} />Download</button></div></article>; }

function AuthModal({ tenant, open, mode, onClose, onModeChange, onSuccess, onToast }) {
  const [form, setForm] = useState({ email: '', password: '', matric: '' });
  const [busy, setBusy] = useState(false);
  const submit = async event => {
    event.preventDefault();
    if (!supabase) { onToast('Supabase is not configured for this browser.'); return; }
    setBusy(true);
    try {
      if (mode === 'signup') {
        const email = form.email.trim().toLowerCase();
        const matric = form.matric.trim().toUpperCase();
        const domain = email.split('@')[1] || '';
        const allowedDomains = Array.isArray(tenant?.allowed_domains) ? tenant.allowed_domains : [];
        const schoolDomains = allowedDomains.filter(item => item && !item.includes('.local'));
        if (schoolDomains.length && !schoolDomains.some(item => domain === item.toLowerCase())) throw new Error(`Use your school email (${schoolDomains.join(' or ')}).`);
        const identity = await invoke('student-identity', { matric, email, tenant_slug: tenant?.slug || 'kasu' });
        const registry = identity.student;
        const { data, error } = await supabase.auth.signUp({ email, password: form.password, options: { data: { full_name: registry.full_name, matric: registry.matric, department: registry.department, department_id: registry.department_id, course_id: registry.course_id, supervisor_email: registry.supervisor_email, degree: registry.degree, avatar_url: registry.avatar_url, role: 'student', tenant_slug: tenant?.slug || 'kasu' } } });
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
  const isLogin = mode === 'login';
  return <Modal open={open} onClose={onClose} eyebrow="Secure access" title={isLogin ? 'Login to Portal' : 'Create Account'} variant="auth">
    <form className="auth-form" onSubmit={submit}>
      <p className="auth-description">{isLogin ? 'Use your institutional account to continue to your role-based research workspace.' : 'Enter your matric number to verify enrollment, then create your secure student account.'}</p>
      {!isLogin && <div className="field"><label htmlFor="auth-matric">Matric number</label><input id="auth-matric" required value={form.matric} onChange={e => setForm({ ...form, matric: e.target.value })} placeholder="KASU/SCI/20/123" /></div>}
      <div className="field"><label htmlFor="auth-email">Email address</label><input id="auth-email" type="email" required value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="student@kasu.edu.ng" /></div>
      <div className="field"><label htmlFor="auth-password">Password</label><input id="auth-password" type="password" minLength="6" required value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} placeholder={isLogin ? 'Enter your password' : 'Minimum 6 characters'} /></div>
      <button className="button button-primary auth-submit" disabled={busy}>{isLogin ? <ArrowRight size={16} /> : <UserPlus size={16} />}{busy ? 'Working...' : isLogin ? 'Sign In' : 'Create Account'}</button>
    </form>
    <div className="auth-switch">{isLogin ? 'New to the portal?' : 'Already registered?'} <button type="button" onClick={() => onModeChange(isLogin ? 'signup' : 'login')}>{isLogin ? 'Create an account' : 'Sign in'}</button></div>
  </Modal>;
}

function Workspace({ role, title, subtitle, children, sidebar = [] }) { return <div className="workspace-shell"><aside className="sidebar"><div className="sidebar-head"><span className="sidebar-mark"><ShieldCheck size={18} /></span><div><strong>{role === 'teacher' ? 'Supervisor' : role[0].toUpperCase() + role.slice(1)} panel</strong><small>Operations center</small></div></div><nav className="sidebar-nav">{sidebar.map(([Icon,label,active,onClick]) => <button className={active ? 'active' : ''} key={label} onClick={onClick}><Icon size={16} />{label}</button>)}</nav></aside><section className="workspace-main blueprint"><div className="workspace-head"><div><p className="eyebrow">{role === 'teacher' ? 'Review workspace' : 'Operations workspace'}</p><h1>{title}</h1><p>{subtitle}</p></div></div>{children}</section></div>; }
function MetricCards({ items }) { return <div className="metric-grid">{items.map(([label,value,Icon]) => <div className="metric-card" key={label}><div className="metric-icon"><Icon size={16} /></div><small>{label}</small><strong>{value}</strong></div>)}</div>; }
function StudentProfileCard({ profile }) { const name = profile?.full_name || 'Student'; const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || 'S'; return <section className="student-profile-card"><div className="student-profile-avatar">{profile?.avatar_url ? <img src={profile.avatar_url} alt="" /> : initials}</div><div className="student-profile-copy"><p className="eyebrow">Official student profile</p><h2>{name}</h2><div className="student-profile-meta"><span>{profile?.matric || 'Matric pending'}</span><span>{profile?.department || 'Department pending'}</span><span>{profile?.degree || 'Degree pending'}</span></div></div><span className="tag"><LockKeyhole size={12} />Registry verified</span></section>; }

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
  const [maxPdfBytes, setMaxPdfBytes] = useState(DEFAULT_MAX_PDF_BYTES);
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    if (preview || !session || !supabase) return undefined;
    Promise.all([
      supabase.from('projects').select('*').eq('student_id', session.user.id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('payments').select('*').eq('student_id', session.user.id).eq('status', 'success').eq('transaction_type', 'clearance_fee').order('created_at', { ascending: false }).limit(1).maybeSingle(),
      loadSystemConfig(profile?.institution_id),
      supabase.from('clearance_receipts').select('*').eq('student_id', session.user.id).order('issued_at', { ascending: false }).limit(1).maybeSingle(),
    ]).then(([projectResult, paymentResult, configResult, receiptResult]) => { setProject(projectResult.data || null); setPayment(paymentResult.data || null); setReceipt(receiptResult.data || null); setClearanceFee(configResult?.clearance_fee_kobo || 200000); setMaxPdfBytes(Number(configResult?.max_pdf_size_bytes) || DEFAULT_MAX_PDF_BYTES); if (projectResult.data) setForm({ title: projectResult.data.title || '', degree: projectResult.data.degree || 'BSc', abstract: projectResult.data.abstract || '' }); }).catch(error => onToast(error.message || 'Student workspace could not be loaded.')).finally(() => setLoading(false));
    return undefined;
  }, [onToast, preview, session, profile]);
  useEffect(() => { let active = true; let objectUrl = ''; if (!receipt?.qr_payload) { setReceiptQrUrl(''); return undefined; } fetchQrSvg(receipt.qr_payload).then(url => { objectUrl = url; if (active) setReceiptQrUrl(url); }).catch(() => { if (active) setReceiptQrUrl(''); }); return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); }; }, [receipt?.qr_payload]);
  const submit = async event => {
    event.preventDefault();
    const fileError = validateThesisFile(file, maxPdfBytes);
    if (fileError) { onToast(fileError); return; }
    if (form.abstract.trim().length < 50) { onToast('Provide an abstract of at least 50 characters.'); return; }
    if (!session || preview) { onToast('Preview mode shows the complete workflow without creating a transaction.'); return; }
    if (submitting) return;
    const selectedFile = file;
    setSubmitting(true);
    try {
      if (project?.status === 'revision_requested' && payment) {
        const path = `${session.user.id}/${Date.now()}-revision-${selectedFile.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
        const upload = await supabase.storage.from('thesis-pdfs').upload(path, selectedFile, { contentType: 'application/pdf', upsert: false });
        if (upload.error) throw upload.error;
        const data = await invoke('project-workflow', { action: 'student_resubmit', project_id: project.id, file_path: upload.data.path, file_name: selectedFile.name, file_size_bytes: selectedFile.size, mime_type: selectedFile.type || 'application/pdf', title: form.title, abstract: form.abstract, degree: form.degree, course_id: profile?.course_id || null });
        setProject(data.project); setFile(null); setSubmitting(false); onToast('Revision resubmitted. No second payment was taken.'); return;
      }
      const init = await invoke('verify-paystack', { action: 'initialize_clearance' });
      resumePaystackPayment(init, {
        onSuccess: async response => {
          try {
            const reference = response?.reference || response?.trxref || init.reference;
            const path = `${session.user.id}/${Date.now()}-${selectedFile.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
            const upload = await supabase.storage.from('thesis-pdfs').upload(path, selectedFile, { contentType: 'application/pdf', upsert: false });
            if (upload.error) throw upload.error;
            const data = await retryPaymentVerification(reference, { file_name: selectedFile.name, file_path: upload.data.path, title: form.title, abstract: form.abstract, degree: form.degree, course_id: profile?.course_id || null, file_size_bytes: selectedFile.size, mime_type: selectedFile.type || 'application/pdf' });
            setPayment(data.payment); setProject(data.project); setFile(null); onToast('Payment verified and thesis submitted for review.');
          } catch (error) {
            onToast(`Payment completed, but submission could not finish: ${error.message}`);
          } finally {
            setSubmitting(false);
          }
        },
        onCancel: () => { setSubmitting(false); onToast('Payment was cancelled.'); },
        onError: error => { setSubmitting(false); onToast(error?.message || 'Paystack could not open.'); },
      });
    } catch (error) { setSubmitting(false); onToast(error.message); }
  };
  const generateReceipt = async () => {
    if (preview) { onToast('Preview receipt is available after the library publishes the record.'); return; }
    if (!project || !['published', 'cleared'].includes(project.status)) { onToast('The receipt becomes available after library publishing.'); return; }
    try { const data = await issueReceipt(project.id); setReceipt(data.receipt); setProject(data.project || { ...project, status: 'cleared' }); onToast('Digital clearance receipt issued.'); }
    catch (error) { onToast(error.message); }
  };
  if (loading) return <PageSkeleton role="student" />;
  return <Workspace role="student" title="Your clearance workspace" subtitle="Submit once, follow every review stage, and keep your official receipt close." sidebar={[[GraduationCap,'My workspace',true],[FileText,'Submission'],[CircleDollarSign,'Payments'],[ShieldCheck,'Receipt']]}><StudentProfileCard profile={profile} /><MetricCards items={[["Workflow status", project ? project.status.replaceAll('_',' ') : 'Not started', FileCheck2],["Clearance fee", formatNaira(clearanceFee), CircleDollarSign],["Submission", project ? 'Received' : 'Awaiting upload', FileText],["Receipt", project?.status === 'cleared' || receipt ? 'Ready' : 'After clearance', Archive]]} /><div className="workspace-grid"><section className="surface span-two"><div className="surface-head"><div><h2>Submission details</h2><p>Capture the metadata your supervisor and library will verify.</p></div>{project && <StatusChip status={project.status} />}</div>{project?.status === 'revision_requested' && <div className="revision-banner"><strong>Revision Required</strong><span>Upload the corrected PDF and resubmit without paying the clearance fee again.</span></div>}<form className="form-grid" onSubmit={submit}><div className="field full"><label htmlFor="project-title-input">Project title</label><input id="project-title-input" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></div><div className="field"><label htmlFor="project-degree-input">Degree</label><select id="project-degree-input" value={form.degree} onChange={e => setForm({ ...form, degree: e.target.value })}><option>BSc</option><option>PGD</option><option>MSc</option><option>PhD</option></select></div><div className="field"><label htmlFor="thesis-pdf-input">Thesis PDF</label><input id="thesis-pdf-input" type="file" accept="application/pdf,.pdf" onChange={e => { const selected = e.target.files?.[0] || null; setFile(selected); const error = validateThesisFile(selected, maxPdfBytes); if (error) onToast(error); }} /><span className="helper">PDF only. Maximum {Math.round(maxPdfBytes / (1024 * 1024))} MB.</span></div><div className="field full"><label htmlFor="project-abstract-input">Abstract</label><textarea id="project-abstract-input" value={form.abstract} onChange={e => setForm({ ...form, abstract: e.target.value })} /><span className="helper">Minimum 50 characters. This abstract becomes part of the public catalog after library approval.</span></div><div className="modal-actions field full"><button className="button button-primary" id="pay-btn" disabled={submitting || Boolean(project && ['published','cleared'].includes(project.status))}>{project?.status === 'revision_requested' && payment ? <><RefreshCw size={15} />{submitting ? 'Submitting revision...' : 'Upload Revision & Resubmit'}</> : payment ? <><Check size={15} />Submission successful</> : <><CircleDollarSign size={15} />{submitting ? 'Opening secure checkout...' : 'Pay & submit thesis'}</>}</button></div></form></section><section className="surface"><div className="surface-head"><div><h2>Current status</h2><p>Live workflow checkpoints.</p></div><LockKeyhole size={17} color="#065f46" /></div>{project ? <div className="status-panel"><h3>{project.title}</h3><StatusChip status={project.status} /><div className="progress-track"><div className="progress-fill" style={{ width: `${['submitted','supervisor_review','revision_requested'].includes(project.status) ? 34 : project.status === 'supervisor_approved' ? 62 : project.status === 'library_review' ? 80 : 100}%` }} /></div>{project.revision_note && <p className="helper"><strong>Supervisor note:</strong> {project.revision_note}</p>}</div> : <EmptyState icon={FileText} title="No submission yet" copy="Complete the form to start your clearance journey." />}</section><section className="surface"><div className="surface-head"><div><h2>Payment evidence</h2><p>Every successful payment is tied to your account.</p></div><CircleDollarSign size={17} color="#065f46" /></div>{payment ? <div className="receipt" id="receipt-section"><h3>{previewAction === 'show_receipt' || receipt || project?.status === 'cleared' ? 'Digital Clearance Receipt' : 'Payment captured'}</h3><dl><dt>Reference</dt><dd>{payment.paystack_reference}</dd><dt>Amount</dt><dd>{formatNaira(payment.amount)}</dd><dt>Date</dt><dd>{displayDate(payment.paid_at)}</dd></dl>{receiptQrUrl && <div className="qr-preview"><img src={receiptQrUrl} alt="Clearance receipt verification QR code" /><span className="helper">Scan to verify this clearance receipt.</span></div>}{(previewAction === 'show_receipt' || ['published','cleared'].includes(project?.status)) && <button className="button button-primary" style={{ marginTop: '1rem' }} onClick={generateReceipt}>{receipt ? 'Receipt issued' : 'Issue digital receipt'}</button>}</div> : <EmptyState icon={CircleDollarSign} title="No payment yet" copy="The fee is initialized securely on the server when you submit." />}</section></div></Workspace>;
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
  return <Workspace role="library" title="Library verification desk" subtitle="Verify metadata, assign shelf records, and publish approved research." sidebar={[[Library,'Verification queue',true],[BookOpen,'Public catalogue'],[QrCode,'QR labels'],[Archive,'Archive']]}><MetricCards items={[["Ready for verification", projects.filter(item => item.status === 'supervisor_approved').length, FileCheck2],["Published records", projects.filter(item => item.status === 'published').length, BookOpen],["Shelf labels", projects.length, QrCode],["Privacy", 'Private PDFs', LockKeyhole]]} /><section className="surface"><div className="surface-head"><div><h2>Verification queue</h2><p>Only supervisor-approved projects can enter the public catalogue.</p></div><span className="tag"><QrCode size={12} />QR ready</span></div>{projects.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Research</th><th>Author</th><th>Department</th><th>Status</th><th>Action</th></tr></thead><tbody>{projects.map(item => <tr key={item.id}><td><strong>{item.title}</strong><br /><span className="helper">{item.degree}</span></td><td>{item.author || item.profiles?.full_name || 'Student'}</td><td>{item.dept || 'Computer Science'}</td><td><StatusChip status={item.status} /></td><td><button className="button button-primary button-small" onClick={() => { setSelected(item); setForm({ shelf_number: `KASU-CS-${String(projects.indexOf(item) + 1).padStart(3,'0')}`, doi: '', comment: '' }); }}>Open record</button></td></tr>)}</tbody></table></div> : <EmptyState icon={Library} title="Queue is clear" copy="Supervisor-approved projects will arrive here for metadata verification." />}</section><Modal open={Boolean(selected)} onClose={() => setSelected(null)} eyebrow="Catalog record" title={selected?.title || ''} wide><div className="modal-body-grid"><div><div className="status-panel"><h3>Metadata verification</h3><p className="helper">{selected?.abstract}</p><StatusChip status={selected?.status} /></div><div className="form-grid" style={{ marginTop: '1rem' }}><div className="field"><label htmlFor="shelf-number">Shelf number</label><input id="shelf-number" value={form.shelf_number} onChange={e => setForm({ ...form, shelf_number: e.target.value })} /></div><div className="field"><label htmlFor="doi">DOI or catalogue ID</label><input id="doi" value={form.doi} onChange={e => setForm({ ...form, doi: e.target.value })} placeholder="Optional" /></div><div className="field full"><label htmlFor="lib-comment-input">Library note</label><textarea id="lib-comment-input" value={form.comment} onChange={e => setForm({ ...form, comment: e.target.value })} placeholder="Record the verification note." /></div></div></div><div className="surface"><p className="eyebrow">Publication checklist</p><div className="queue-list">{['Metadata complete','Abstract is discoverable','Private PDF remains protected','QR verification payload ready'].map(item => <div className="queue-item" key={item}><span className="helper">{item}</span><CheckCircle2 size={17} color="#059669" /></div>)}</div>{qrUrl && <div className="qr-preview"><img src={qrUrl} alt="Project verification QR code" /><span className="helper">Scan to verify this public catalog record.</span></div>}</div></div><div className="modal-actions"><button className="button button-ghost" onClick={() => setSelected(null)}>Cancel</button><button className="button button-primary" onClick={publish}><QrCode size={15} />{preview ? 'Verify & Publish' : selected?.status === 'published' ? 'Refresh QR' : 'Verify & Publish'}</button></div></Modal></Workspace>;
}

function AdminLivePanel({ profile, session, initialSection, onToast }) {
  const [section, setSection] = useState(initialSection || 'dashboard');
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState(null);
  const [students, setStudents] = useState([]);
  const [projects, setProjects] = useState([]);
  const [payments, setPayments] = useState([]);
  const [guestOrders, setGuestOrders] = useState([]);
  const [receipts, setReceipts] = useState([]);
  const [selectedReceipt, setSelectedReceipt] = useState(null);
  const [departments, setDepartments] = useState([]);
  const [courses, setCourses] = useState([]);
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
  const [newCourse, setNewCourse] = useState({ name: '', code: '', level: '', department_id: '' });
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
    const receiptQuery = supabase.from('clearance_receipts').select('id,project_id,student_id,verification_code,qr_payload,issued_at,projects(title),profiles!clearance_receipts_student_id_fkey(full_name,matric)').order('issued_at', { ascending: false }).limit(100);
    const departmentQuery = supabase.from('departments').select('id,name,code,faculty_id,faculties(name)').order('name');
    const courseQuery = supabase.from('courses').select('id,name,code,level,department_id,departments(name)').order('name');
    const facultyQuery = supabase.from('faculties').select('id,name,college_id,colleges(name)').order('name');
    const collegeQuery = supabase.from('colleges').select('id,name').order('name');
    if (profile?.institution_id) {
      studentsQuery.eq('institution_id', profile.institution_id);
      projectQuery.eq('institution_id', profile.institution_id);
      receiptQuery.eq('projects.institution_id', profile.institution_id);
      departmentQuery.eq('institution_id', profile.institution_id);
      courseQuery.eq('institution_id', profile.institution_id);
      facultyQuery.eq('institution_id', profile.institution_id);
      collegeQuery.eq('institution_id', profile.institution_id);
    }
    try {
      const [overviewResult, studentsResult, projectResult, paymentResult, guestOrderResult, receiptResult, departmentResult, courseResult, facultyResult, collegeResult, institutionResult, configResult, schedulesResult, reportResult] = await Promise.all([
        supabase.from('admin_overview').select('*').maybeSingle(),
        studentsQuery,
        projectQuery,
        supabase.from('payments').select('id,project_id,amount,currency,status,transaction_type,paystack_reference,created_at,paid_at,payer_id').order('created_at', { ascending: false }).limit(100),
        supabase.from('guest_download_orders').select('id,amount,currency,status,paystack_reference,created_at,unlocked_at,email,project_id,metadata').order('created_at', { ascending: false }).limit(100),
        receiptQuery,
        departmentQuery,
        courseQuery,
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
      setGuestOrders(guestOrderResult.data || []);
      setReceipts(receiptResult.data || []);
      setDepartments(departmentResult.data || []);
      setCourses(courseResult.data || []);
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
      if (table === 'courses') { setCourses(items => [...items, data].sort((a, b) => a.name.localeCompare(b.name))); setNewCourse({ name: '', code: '', level: '', department_id: '' }); }
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
  const downloadReceiptEvidence = receipt => { const blob = new Blob([JSON.stringify(receipt, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `${receipt.verification_code || 'spms-receipt'}.json`; link.click(); URL.revokeObjectURL(url); };
  const successfulPayments = payments.filter(item => item.status === 'success');
  const successfulGuestOrders = guestOrders.filter(item => item.status === 'success');
  const workflowValues = ['submitted', 'supervisor_review', 'revision_requested', 'supervisor_approved', 'library_review', 'published', 'cleared'].map(status => [status.replaceAll('_', ' '), projects.filter(item => item.status === status).length]);
  const revenue = [...successfulPayments, ...successfulGuestOrders].reduce((total, item) => total + Number(item.amount || 0), 0);
  const institutionShare = Number(settings?.institution_share_percent || 50);
  const nav = [[Archive, 'Dashboard', 'dashboard'], [Users, 'Students', 'students'], [UserCheck, 'Supervisors', 'supervisors'], [Library, 'Departments', 'departments'], [FileText, 'Uploads', 'uploads'], [CircleDollarSign, 'Payments', 'payments'], [FileCheck2, 'Reports', 'reports'], [Settings2, 'Settings', 'settings']];
  const metrics = [["Total students", overview?.total_students ?? students.length, Users], ["Total revenue", formatNaira(revenue), CircleDollarSign], ["Total uploads", overview?.total_projects ?? projects.length, FileText], ["Pending approvals", (overview?.pending_supervisor_review || 0) + (overview?.pending_library_review || 0), FileCheck2]];

  if (loading) return <PageSkeleton role="admin" />;
  return <Workspace role="admin" title="Analytics hub" subtitle="Live operations for academic clearance, finance, and institutional governance." sidebar={nav.map(([Icon, label, id]) => [Icon, label, section === id, () => setSection(id)])}>
    <MetricCards items={metrics} />
    {section === 'dashboard' && <div className="workspace-grid"><AnalyticsCard title="Workflow funnel" copy="Current project counts across every clearance stage." values={workflowValues} /><AnalyticsCard title="Revenue split" copy="Successful Paystack transactions reconciled by configured share." values={[["Institution share", institutionShare], ["SPMS provider share", 100 - institutionShare], ["Successful transactions", successfulPayments.length + successfulGuestOrders.length]]} accent /><AnalyticsCard title="Monthly revenue" copy="Latest recorded payment volume." values={[["This month", [...successfulPayments, ...successfulGuestOrders].filter(item => item.created_at && new Date(item.created_at).getMonth() === new Date().getMonth()).reduce((total, item) => total + Number(item.amount || 0), 0) / 100], ["All time", revenue / 100]]} accent /><AnalyticsCard title="Publication progress" copy="Approved catalog records and cleared receipts." values={[["Published", overview?.published_projects || projects.filter(item => item.status === 'published').length], ["Cleared", projects.filter(item => item.status === 'cleared').length]]} /></div>}
    {section === 'students' && <section className="surface"><SectionHeader eyebrow="Student directory" title="Registered students" copy="Searchable student records connected to project ownership and department mapping." /><DataTable columns={['Name', 'Matric', 'Email', 'Department', 'Joined']} rows={students.map(item => [item.full_name || 'Unnamed student', item.matric || '—', item.email || '—', item.department || 'Unassigned', displayDate(item.created_at)])} empty="No student profiles found." /></section>}
    {section === 'supervisors' && <AdminSupervisorQueue profile={profile} onToast={onToast} />}
    {section === 'departments' && <HierarchyManager colleges={colleges} faculties={faculties} departments={departments} courses={courses} newCollege={newCollege} setNewCollege={setNewCollege} newFaculty={newFaculty} setNewFaculty={setNewFaculty} newDepartment={newDepartment} setNewDepartment={setNewDepartment} newCourse={newCourse} setNewCourse={setNewCourse} addHierarchy={addHierarchy} />}
    {section === 'uploads' && <section className="surface"><SectionHeader eyebrow="Project register" title="All thesis uploads" copy="Monitor status, student ownership, academic level, and submission timestamps." /><DataTable columns={['Project', 'Student', 'Degree', 'Status', 'Submitted']} rows={projects.map(item => [item.title, item.profiles?.full_name || 'Student', item.degree || '—', <StatusChip status={item.status} key={`${item.id}-status`} />, displayDate(item.created_at)])} empty="No project uploads found." /></section>}
    {section === 'payments' && <section className="surface"><SectionHeader eyebrow="Finance evidence" title="Payment ledger" copy="Clearance payments and registered repository downloads with references for reconciliation." /><DataTable columns={['Reference', 'Type', 'Amount', 'Status', 'Created', 'Receipt']} rows={[...payments.map(item => { const receipt = receipts.find(record => record.project_id === item.project_id); return [item.paystack_reference || '—', item.transaction_type?.replaceAll('_', ' ') || '—', formatNaira(item.amount), item.status || '—', displayDate(item.created_at), receipt ? <button className="button button-ghost button-small" onClick={() => setSelectedReceipt(receipt)}>View</button> : '—']; }), ...guestOrders.map(item => [item.paystack_reference || '—', 'legacy guest download', formatNaira(item.amount), item.status || '—', displayDate(item.created_at), '—'])]} empty="No payment records found." /><Modal open={Boolean(selectedReceipt)} onClose={() => setSelectedReceipt(null)} eyebrow="Clearance evidence" title={selectedReceipt?.verification_code || 'Receipt'}><div className="receipt"><h3>{selectedReceipt?.projects?.title || 'Clearance receipt'}</h3><dl><dt>Student</dt><dd>{selectedReceipt?.profiles?.full_name || '—'}</dd><dt>Matric</dt><dd>{selectedReceipt?.profiles?.matric || '—'}</dd><dt>Issued</dt><dd>{displayDate(selectedReceipt?.issued_at)}</dd><dt>Verification code</dt><dd>{selectedReceipt?.verification_code || '—'}</dd></dl></div><div className="modal-actions"><button className="button button-ghost" onClick={() => setSelectedReceipt(null)}>Close</button>{selectedReceipt && <button className="button button-primary" onClick={() => downloadReceiptEvidence(selectedReceipt)}><Download size={15} />Download evidence</button>}</div></Modal></section>}
    {section === 'reports' && <AdminReports schedules={schedules} generatedReports={generatedReports} schedule={schedule} setSchedule={setSchedule} createSchedule={createSchedule} generateReport={generateReport} runDue={runDue} />}
    {section === 'settings' && <AdminSettings institution={institution} settings={settings} onInstitutionChange={updateInstitution} onSettingsChange={updateSettings} onSave={saveSettings} saving={saving} />}
  </Workspace>;
}

function DataTable({ columns, rows, empty }) { return rows.length ? <div className="table-wrap"><table className="data-table"><thead><tr>{columns.map(column => <th key={column}>{column}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div> : <EmptyState icon={Archive} title={empty} copy="New records will appear here as the workflow is used." />; }

function HierarchyManager({ colleges, faculties, departments, courses, newCollege, setNewCollege, newFaculty, setNewFaculty, newDepartment, setNewDepartment, newCourse, setNewCourse, addHierarchy }) {
 return <section className="surface"><SectionHeader eyebrow="Academic structure" title="Colleges, faculties, departments, and courses" copy="Maintain the academic hierarchy used for student identity, supervisor matching, project metadata, and reports." /><div className="hierarchy-forms"><form className="inline-form" onSubmit={event => { event.preventDefault(); addHierarchy('colleges', { name: newCollege }); }}><label htmlFor="new-college">College</label><input id="new-college" value={newCollege} onChange={event => setNewCollege(event.target.value)} placeholder="College name" /><button className="button button-primary button-small"><Plus size={14} />Add</button></form><form className="inline-form" onSubmit={event => { event.preventDefault(); addHierarchy('faculties', newFaculty); }}><label htmlFor="new-faculty">Faculty</label><input id="new-faculty" value={newFaculty.name} onChange={event => setNewFaculty({ ...newFaculty, name: event.target.value })} placeholder="Faculty name" /><select value={newFaculty.college_id} onChange={event => setNewFaculty({ ...newFaculty, college_id: event.target.value })} aria-label="College for new faculty"><option value="">College</option>{colleges.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select><button className="button button-primary button-small"><Plus size={14} />Add</button></form><form className="inline-form" onSubmit={event => { event.preventDefault(); addHierarchy('departments', newDepartment); }}><label htmlFor="new-department">Department</label><input id="new-department" value={newDepartment.name} onChange={event => setNewDepartment({ ...newDepartment, name: event.target.value })} placeholder="Department name" /><input value={newDepartment.code} onChange={event => setNewDepartment({ ...newDepartment, code: event.target.value })} placeholder="Code" aria-label="Department code" /><select value={newDepartment.faculty_id} onChange={event => setNewDepartment({ ...newDepartment, faculty_id: event.target.value })} aria-label="Faculty for new department"><option value="">Faculty</option>{faculties.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select><button className="button button-primary button-small"><Plus size={14} />Add</button></form><form className="inline-form" onSubmit={event => { event.preventDefault(); addHierarchy('courses', newCourse); }}><label htmlFor="new-course">Course</label><input id="new-course" value={newCourse.name} onChange={event => setNewCourse({ ...newCourse, name: event.target.value })} placeholder="Course name" /><input value={newCourse.code} onChange={event => setNewCourse({ ...newCourse, code: event.target.value })} placeholder="Course code" aria-label="Course code" /><select value={newCourse.level} onChange={event => setNewCourse({ ...newCourse, level: event.target.value })} aria-label="Course level"><option value="">Level</option><option value="Undergraduate">Undergraduate</option><option value="Postgraduate">Postgraduate</option><option value="Professional">Professional</option></select><select value={newCourse.department_id} onChange={event => setNewCourse({ ...newCourse, department_id: event.target.value })} aria-label="Department for new course"><option value="">Department</option>{departments.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select><button className="button button-primary button-small"><Plus size={14} />Add</button></form></div><div className="hierarchy-grid"><div><h3>Colleges</h3>{colleges.map(item => <div className="queue-item" key={item.id}><span>{item.name}</span></div>)}</div><div><h3>Faculties</h3>{faculties.map(item => <div className="queue-item" key={item.id}><span>{item.name}</span><small>{item.colleges?.name || 'College not mapped'}</small></div>)}</div><div><h3>Departments</h3>{departments.map(item => <div className="queue-item" key={item.id}><span>{item.name}</span><small>{item.code || 'No code'} · {item.faculties?.name || 'Faculty not mapped'}</small></div>)}</div><div><h3>Courses</h3>{courses.map(item => <div className="queue-item" key={item.id}><span>{item.code} · {item.name}</span><small>{item.level || 'Level not set'} · {item.departments?.name || 'Department not mapped'}</small></div>)}</div></div></section>;
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
function AnalyticsCard({ title, copy, values, accent = false }) { const max = Math.max(1, ...values.map(([,value]) => Number(value) || 0)); return <section className="surface"><div className="surface-head"><div><h2>{title}</h2><p>{copy}</p></div><span className="tag">{accent ? 'Reconciliation' : 'Live status'}</span></div><div className="queue-list">{values.map(([label,value]) => { const numericValue = Number(value) || 0; const width = Math.min(100, Math.max(0, (numericValue / max) * 100)); return <div key={label}><div style={{ display: 'flex', justifyContent: 'space-between', color: '#40536b', fontSize: '.75rem', fontWeight: 700, marginBottom: '.4rem' }}><span>{label}</span><span>{accent ? `${value}%` : value}</span></div><div className="progress-track"><div className="progress-fill" style={{ width: `${width}%`, background: accent ? '#f59e0b' : '#065f46' }} /></div></div>; })}</div></section>; }
