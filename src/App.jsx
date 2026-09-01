import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Archive, ArrowRight, Bell, BookOpen, Check, CheckCircle2, CircleDollarSign, Download, FileCheck2, FileText, GraduationCap, Library, LockKeyhole, Mail, PencilLine, Phone, Plus, QrCode, RefreshCw, Save, Search, Send, Settings2, ShieldCheck, UserCheck, UserPlus, Users, XCircle } from 'lucide-react';
import qrcode from 'qrcode-generator';
import { AppShell, EmptyState, SearchBox, SectionHeader } from './components/AppShell';
import { Modal } from './components/Modal';
import { PageSkeleton, RepositorySkeleton } from './components/Skeleton';
import { StatusChip } from './components/StatusChip';
import { config, fallbackTenant, invoke, loadProfile, loadSystemConfig, loadTenant, signedPdfUrl, supabase } from './lib/supabase';
import { fetchQrSvg, issueReceipt, lookupVerification, retryPaymentVerification, runDueReports, runScheduledReport } from './lib/contracts';
import { demoProjects, demoReviewProjects, demoStats } from './data/demo';
import './styles.css';

const previewParams = new URLSearchParams(window.location.search);
const isLocalHost = hostname => ['localhost', '127.0.0.1', '0.0.0.0'].includes(hostname);
const isRolePreviewAllowed = () => isLocalHost(window.location.hostname) && ['student', 'teacher', 'library', 'admin'].includes(previewParams.get('preview_role'));
const isPublicPreviewAllowed = () => isLocalHost(window.location.hostname) && previewParams.get('preview_surface') === 'public';
const previewRole = isRolePreviewAllowed() ? previewParams.get('preview_role') : '';
const previewPublic = isPublicPreviewAllowed() && !previewRole;
const previewAction = previewParams.get('preview_action') || '';

function formatNaira(kobo = 0) { return new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', maximumFractionDigits: 0 }).format(Number(kobo) / 100); }
function displayDate(value) { return value ? new Date(value).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; }
function escapePdfText(value) { return String(value ?? '').replace(/[^\x20-\x7e]/g, '?').replace(/[\\()]/g, '\\$&'); }
function receiptQrCommands(payload) {
  const qr = qrcode(0, 'M');
  qr.addData(String(payload || 'SPMS receipt verification'));
  qr.make();
  const moduleCount = qr.getModuleCount();
  const margin = 4;
  const cell = 4;
  const originX = 390;
  const originY = 74;
  const commands = ['0 0 0 rg'];
  for (let row = 0; row < moduleCount; row += 1) {
    for (let column = 0; column < moduleCount; column += 1) {
      if (!qr.isDark(row, column)) continue;
      const x = originX + (column + margin) * cell;
      const y = originY + (moduleCount - row + margin) * cell;
      commands.push(`${x} ${y} ${cell} ${cell} re f`);
    }
  }
  commands.push(`BT /F1 9 Tf ${originX} 56 Td (Scan to verify this receipt) Tj ET`);
  return commands;
}
function downloadReceiptPdf(receipt, project, payment, profile) {
  if (!receipt) return;
  const lines = [
    'KASU SPMS - DIGITAL CLEARANCE RECEIPT',
    '',
    `Verification code: ${receipt.verification_code || 'Not available'}`,
    `Student: ${receipt.profiles?.full_name || profile?.full_name || 'Student'}`,
    `Matric: ${receipt.profiles?.matric || profile?.matric || 'Not available'}`,
    `Project: ${project?.title || 'Research project'}`,
    `Payment reference: ${payment?.paystack_reference || 'Not available'}`,
    `Amount: ${payment ? formatNaira(payment.amount) : 'Not available'}`,
    `Issued: ${displayDate(receipt.issued_at)}`,
    '',
    'Verify this receipt from the public SPMS verification form using the code above.',
  ];
  const qrPayload = receipt.qr_payload || JSON.stringify({ type: 'spms-clearance-receipt', verification_code: receipt.verification_code });
  const streamParts = [`BT /F1 18 Tf 72 720 Td (${escapePdfText(lines[0])}) Tj`, '/F1 11 Tf'];
  lines.slice(1).forEach(line => streamParts.push(`0 -24 Td (${escapePdfText(line)}) Tj`));
  streamParts.push('ET');
  streamParts.push(...receiptQrCommands(qrPayload));
  const stream = streamParts.join('\n');
  const byteLength = value => new TextEncoder().encode(value).length;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  const blob = new Blob([new TextEncoder().encode(pdf)], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${String(receipt.verification_code || 'kasu-spms-receipt').replace(/[^a-z0-9_-]+/gi, '-')}.pdf`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
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
  const [guestDownloadProject, setGuestDownloadProject] = useState(null);
  const [toast, setToast] = useState('');
  const [notifications, setNotifications] = useState([]);
  const [notificationsOpen, setNotificationsOpen] = useState(false);

  const notify = useCallback(message => { setToast(message); window.setTimeout(() => setToast(''), 4200); }, []);
  const role = profile?.role || (previewRole || '');

  useEffect(() => {
    document.documentElement.dataset.rolePreview = previewRole || '';
    document.documentElement.dataset.rolePreviewAction = previewAction;
    document.documentElement.dataset.publicPreview = previewPublic ? 'true' : '';
    const bootstrap = async () => {
      if (previewRole || previewPublic) {
        setTenant(fallbackTenant);
        if (previewRole) setProfile({ id: `preview-${previewRole}-user`, role: previewRole, full_name: previewRole === 'teacher' ? 'Dr. Sani Musa' : previewRole === 'admin' ? 'SPMS Administrator' : previewRole === 'library' ? 'Library Officer' : 'Musa Abdullahi', matric: 'KASU/SCI/20/123', department: 'Computer Science', email: `${previewRole}.preview@kasu.edu.ng` });
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
    if (!supabase || previewRole || previewPublic) return undefined;
    const { data } = supabase.auth.onAuthStateChange(async (_event, nextSession) => {
      setSession(nextSession);
      if (nextSession) setProfile(await loadProfile(nextSession.user.id)); else setProfile(null);
    });
    return () => data.subscription.unsubscribe();
  }, [notify]);

  useEffect(() => {
    if (!supabase || !session || previewRole || previewPublic) return undefined;
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
  const openNotificationCenter = () => setNotificationsOpen(true);
  const closeNotificationCenter = () => setNotificationsOpen(false);
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
      setGuestDownloadProject(project);
      return;
    }
    continueRepositoryDownload(project);
  };
  if (booting) return <><AppShell tenant={tenant} onHome={goHome} onLogin={openLogin}><PageSkeleton role="landing" /></AppShell></>;
  return <AppShell tenant={tenant} role={role} onHome={goHome} onLogin={openLogin} onLogout={logout} notificationCount={notifications.length} onNotifications={openNotificationCenter}>
    {view === 'landing' && <Landing tenant={tenant} session={session} profile={profile} localPreview={previewPublic} onLogin={openLogin} onWorkspace={() => role ? enterWorkspace(role) : openLogin()} onDownload={handleDownload} configError={!config.valid && !previewRole && !previewPublic} />}
    {view === 'student' && <StudentWorkspace profile={profile} session={session} preview={Boolean(previewRole)} onToast={notify} onProfileUpdate={setProfile} />}
    {view === 'teacher' && <TeacherWorkspace profile={{ ...profile, _contactEditor: { session, preview: Boolean(previewRole), onProfileUpdate: setProfile, onToast: notify } }} session={session} preview={Boolean(previewRole)} onToast={notify} onProfileUpdate={setProfile} />}
    {view === 'library' && <LibraryWorkspace profile={profile} session={session} preview={Boolean(previewRole)} onToast={notify} />}
    {view === 'admin' && <AdminWorkspace profile={profile} session={session} preview={Boolean(previewRole)} onToast={notify} />}
    <GuestDownloadModal project={guestDownloadProject} onClose={() => setGuestDownloadProject(null)} onSignIn={() => { setGuestDownloadProject(null); setAuthMode('login'); setAuthOpen(true); }} onCreateAccount={() => { setGuestDownloadProject(null); setAuthMode('signup'); setAuthOpen(true); }} />
    <AuthModal tenant={tenant} open={authOpen} mode={authMode} onClose={() => setAuthOpen(false)} onModeChange={setAuthMode} onSuccess={(nextSession, nextProfile) => { setSession(nextSession); setProfile(nextProfile); enterWorkspace(nextProfile.role); }} onToast={notify} />
    <Modal open={notificationsOpen} onClose={closeNotificationCenter} eyebrow="Workflow activity" title="Notification center" wide>
      {notifications.length ? <div className="notification-list">{notifications.map(notification => <article className="notification-item" key={notification.id}><div className="notification-item-icon"><Bell size={16} /></div><div className="notification-item-copy"><div className="notification-item-head"><strong>{notification.title}</strong><span className="tag">Unread</span></div><p>{notification.message}</p><small>{displayDate(notification.created_at)}</small></div></article>)}</div> : <EmptyState icon={Bell} title="You are all caught up" copy="New submission, review, publication, and receipt updates will appear here." />}
      <div className="modal-actions"><button className="button button-ghost" type="button" onClick={closeNotificationCenter}>Close</button>{notifications.length > 0 && <button className="button button-primary" type="button" onClick={() => { markNotificationsRead(); closeNotificationCenter(); }}><CheckCircle2 size={15} />Mark all as read</button>}</div>
    </Modal>
    {toast && <div className="toast" role="status">{toast}</div>}
  </AppShell>;
}

function Landing({ tenant, session, profile, localPreview = false, onLogin, onWorkspace, onDownload, configError }) {
  const [query, setQuery] = useState('');
  const [projects, setProjects] = useState(localPreview || !config.valid ? demoProjects : []);
  const [impact, setImpact] = useState(localPreview || !config.valid ? demoStats : { students: '—', submitted: '—', approved: '—', departments: '—' });
  const [abstractProject, setAbstractProject] = useState(null);
  const [catalogLoading, setCatalogLoading] = useState(Boolean(supabase));
  const departmentScope = profile?.role === 'student' ? String(profile.department || '').trim() : '';
  useEffect(() => {
    if (localPreview) {
      setCatalogLoading(true);
      const timer = window.setTimeout(() => setCatalogLoading(false), 450);
      return () => window.clearTimeout(timer);
    }
    if (!supabase || !tenant?.id) {
      setCatalogLoading(false);
      if (supabase) {
        setProjects([]);
        setImpact({ students: '—', submitted: '—', approved: '—', departments: '—' });
      }
      return undefined;
    }
    let active = true;
    setCatalogLoading(true);
    const searchTerm = query.trim().replace(/[^a-zA-Z0-9\s_-]/g, ' ').replace(/\s+/g, ' ').slice(0, 80);
    const catalogQuery = supabase.from('public_catalog').select('id, title, department_name, course_name, degree, abstract, published_at, project_id, institution_id').order('published_at', { ascending: false }).limit(12);
    const publishedCountQuery = supabase.from('public_catalog').select('id', { count: 'exact', head: true });
    const departmentQuery = supabase.from('public_catalog').select('department_id');
    if (tenant?.id) {
      catalogQuery.eq('institution_id', tenant.id);
      publishedCountQuery.eq('institution_id', tenant.id);
      departmentQuery.eq('institution_id', tenant.id);
    }
    if (departmentScope) {
      catalogQuery.eq('department_name', departmentScope);
      publishedCountQuery.eq('department_name', departmentScope);
      departmentQuery.eq('department_name', departmentScope);
    }
    if (searchTerm) catalogQuery.or(`title.ilike.%${searchTerm}%,department_name.ilike.%${searchTerm}%,course_name.ilike.%${searchTerm}%,abstract.ilike.%${searchTerm}%`);
    Promise.all([catalogQuery, publishedCountQuery, departmentQuery]).then(([catalogResult, publishedResult, departmentResult]) => {
      if (!active) return;
      if (catalogResult.error) throw catalogResult.error;
      setProjects((catalogResult.data || []).map(item => ({ ...item, author: 'Anonymized researcher', dept: item.department_name, course: item.course_name, status: 'published' })));
      const departments = new Set((departmentResult.data || []).map(item => item.department_id).filter(Boolean));
      setImpact({ students: '—', submitted: '—', approved: publishedResult.count ?? 0, departments: departments.size || '—' });
    }).catch(() => { if (active) { setProjects([]); setImpact({ students: '—', submitted: '—', approved: '—', departments: '—' }); } }).finally(() => { if (active) setCatalogLoading(false); });
    return () => { active = false; };
  }, [departmentScope, localPreview, query, tenant?.id]);
  const visibleProjects = projects.filter(project => (!departmentScope || String(project.dept || project.department_name || '').toLowerCase() === departmentScope.toLowerCase()) && [project.title, project.author, project.dept, project.course, project.degree].join(' ').toLowerCase().includes(query.toLowerCase()));
  return <div className="blueprint">
    {configError && <div className="config-alert" id="app-config-error" role="alert"><Settings2 size={16} /><span>Browser configuration is incomplete. Add the public Supabase URL, anon key, and Paystack public key in <code>js/config.js</code> before signing in or submitting.</span></div>}
    <section className="hero"><div className="hero-grid"><div><p className="eyebrow">{tenant.name || 'Kaduna State University'}</p><h1>{tenant.short_name || 'KASU'} <span>SPMS</span></h1><p className="hero-copy">A single workspace for final-year submissions, supervisor review, library publishing, verified receipts, Paystack reconciliation, and controlled repository access.</p><div className="hero-actions"><button className="button button-accent" onClick={onLogin}><LogInIcon />Login to portal</button><button className="button button-ghost" onClick={() => document.getElementById('repository')?.scrollIntoView({ behavior: 'smooth' })}><Search size={16} />Browse repository</button>{session ? <button className="button button-ghost" onClick={onWorkspace}><ArrowRight size={16} />Open workspace</button> : <button className="button button-ghost" onClick={onLogin}>Create account</button>}</div></div><OperationsBoard /></div></section>
    <div className="trust-band"><ShieldCheck size={15} /> Simple, auditable workflow from submission to digital clearance</div>
    <section className="timeline-section"><div className="center-heading"><p className="eyebrow">One connected process</p><h2>The Clearance Process</h2><p className="muted">Every stage is visible, accountable, and connected from the first student submission to final digital clearance.</p></div><div className="timeline">{[[GraduationCap,'Student Login'],[FileText,'Upload Thesis'],[UserCheck,'Supervisor Approval'],[Library,'Library Verification'],[CheckCircle2,'Clearance Completed']].map(([Icon, label]) => <div className="timeline-step" key={label}><span className="timeline-icon"><Icon size={19} /></span><strong>{label}</strong></div>)}</div></section>
    <section className="impact-section"><div className="center-heading"><p className="eyebrow">Institutional signal</p><h2>Institutional Impact</h2></div><div className="metrics-grid">{[[impact.students,'Students'],[impact.submitted,'Projects submitted'],[impact.approved,'Approved'],[impact.departments,'Departments']].map(([value,label]) => <div className="impact-metric" key={label}><strong>{value}</strong><span>{label}</span></div>)}</div></section>
    <section className="repository-section" id="repository"><div className="page-pad" style={{ paddingTop: 0, paddingBottom: 0 }}><SectionHeader eyebrow="Public repository" title="Browse Past Research" copy={departmentScope ? `Showing approved ${departmentScope} projects for your student account.` : 'Read approved abstracts for free. Full thesis access requires an authenticated student account.'} action={<span className="tag"><LockKeyhole size={12} />Private files protected</span>} /><div className="repository-toolbar"><SearchBox value={query} onChange={setQuery} placeholder="Search titles, departments, or courses" /><span className="muted" style={{ fontSize: '.75rem', alignSelf: 'center' }}>{catalogLoading ? 'Loading catalog...' : `${visibleProjects.length} catalog records`}</span></div>{catalogLoading ? <RepositorySkeleton /> : <div className="repo-grid">{visibleProjects.map(project => <ProjectCard project={project} key={project.id} onAbstract={() => setAbstractProject(project)} onDownload={onDownload} />)}</div>}{!catalogLoading && !visibleProjects.length && <EmptyState icon={Search} title="No matching research" copy="Try a broader title, department, or course search." />}</div></section>
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
function truncateText(value, limit = 180) { const text = String(value || 'Abstract unavailable.'); return text.length > limit ? `${text.slice(0, limit).trimEnd()}...` : text; }
function ProfileAvatar({ name = 'Student', src, size = 'avatar-small' }) { const initials = String(name).split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || 'S'; return src ? <img className={size} src={src} alt="" /> : <span className={`${size} avatar-fallback`} aria-hidden="true">{initials}</span>; }
function ProjectCard({ project, onAbstract, onDownload }) { const downloadProject = project.project_id ? { ...project, id: project.project_id } : project; return <article className="project-card"><div className="project-meta"><span className="tag">{project.degree || 'Research'}</span><span>{project.course || project.dept || 'Institution'}</span></div><h3>{project.title}</h3><p>{truncateText(project.abstract)}</p><div className="card-actions"><button className="button button-ghost button-small" onClick={onAbstract}>View abstract</button><button className="button button-primary button-small" onClick={() => onDownload(downloadProject)}><Download size={14} />Download</button></div></article>; }

function GuestDownloadModal({ project, onClose, onSignIn, onCreateAccount }) {
  return <Modal open={Boolean(project)} onClose={onClose} eyebrow="Account required" title="Sign in to download">
    <div className="auth-form">
      <div className="status-panel"><h3>{project?.title || 'Research project'}</h3><p className="helper">Abstracts are free to read. Create or use your authenticated student account to pay for a watermarked download. Your matric number identifies the downloaded copy.</p></div>
      <div className="modal-actions"><button className="button button-ghost" type="button" onClick={onClose}>Cancel</button><button className="button button-ghost" type="button" onClick={onSignIn}><ArrowRight size={15} />Sign in</button><button className="button button-primary" type="button" onClick={onCreateAccount}><UserPlus size={15} />Create account</button></div>
    </div>
  </Modal>;
}

function AuthModal({ tenant, open, mode, onClose, onModeChange, onSuccess, onToast }) {
  const [form, setForm] = useState({ email: '', password: '', matric: '', full_name: '', department: '' });
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
        const fullName = form.full_name.trim();
        const department = form.department.trim();
        if (!fullName || !department) throw new Error('Enter your full name and department to create your student account.');
        const identity = await invoke('student-identity', { matric, email, full_name: fullName, department, tenant_slug: tenant?.slug || 'kasu' });
        const registry = identity.student;
        const { data, error } = await supabase.auth.signUp({ email, password: form.password, options: { data: { full_name: registry.full_name, matric: registry.matric, department: registry.department, department_id: registry.department_id, course_id: registry.course_id, supervisor_email: registry.supervisor_email, degree: registry.degree, avatar_url: registry.avatar_url, role: 'student', tenant_slug: tenant?.slug || 'kasu' } } });
        if (error) {
          if (error.code === 'email_exists' || /already registered|already exists/i.test(error.message || '')) throw new Error('An account with this email already exists. Sign in instead.');
          throw error;
        }
        if (data.user?.identities && data.user.identities.length === 0) throw new Error('An account with this email already exists. Sign in instead.');
        if (!data.session) { onToast('Account created. Check your email to confirm access before signing in.'); onClose(); return; }
        onSuccess(data.session, await loadProfile(data.user.id));
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({ email: form.email, password: form.password });
        if (error) {
          if (/email not confirmed/i.test(error.message || '')) throw new Error('Confirm your email address before signing in.');
          throw error;
        }
        onSuccess(data.session, await loadProfile(data.user.id));
      }
    } catch (error) { onToast(error.message); } finally { setBusy(false); }
  };
  const isLogin = mode === 'login';
  return <Modal open={open} onClose={onClose} eyebrow="Secure access" title={isLogin ? 'Login to Portal' : 'Create Account'} variant="auth">
    <form className="auth-form" onSubmit={submit}>
      <p className="auth-description">{isLogin ? 'Use your institutional account to continue to your role-based research workspace.' : 'Enter your details to create a student account. Your department can be assigned or updated by an administrator.'}</p>
      {!isLogin && <><div className="field"><label htmlFor="auth-matric">Matric number</label><input id="auth-matric" required value={form.matric} onChange={e => setForm({ ...form, matric: e.target.value })} placeholder="Your matric number" /></div><div className="field"><label htmlFor="auth-full-name">Full name</label><input id="auth-full-name" required value={form.full_name} onChange={e => setForm({ ...form, full_name: e.target.value })} placeholder="Enter your full name" /></div><div className="field"><label htmlFor="auth-department">Department</label><input id="auth-department" required value={form.department} onChange={e => setForm({ ...form, department: e.target.value })} placeholder="Enter your department" /></div></>}
      <div className="field"><label htmlFor="auth-email">Email address</label><input id="auth-email" type="email" required value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="student@kasu.edu.ng" /></div>
      <div className="field"><label htmlFor="auth-password">Password</label><input id="auth-password" type="password" minLength="6" required value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} placeholder={isLogin ? 'Enter your password' : 'Minimum 6 characters'} /></div>
      <button className="button button-primary auth-submit" disabled={busy}>{isLogin ? <ArrowRight size={16} /> : <UserPlus size={16} />}{busy ? 'Working...' : isLogin ? 'Sign In' : 'Create Account'}</button>
    </form>
    <div className="auth-switch">{isLogin ? 'New to the portal?' : 'Already registered?'} <button type="button" onClick={() => onModeChange(isLogin ? 'signup' : 'login')}>{isLogin ? 'Create an account' : 'Sign in'}</button></div>
  </Modal>;
}

function scrollToWorkspaceSection(id) { document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
function workspaceSectionTarget(role, label) {
  const targets = {
    student: { 'My workspace': 'student-overview', Submission: 'student-submission', Payments: 'student-payments', Receipt: 'student-receipt' },
    teacher: { 'Assigned students': 'teacher-assigned', 'Review history': 'teacher-history', Preferences: 'teacher-preferences' },
    library: { 'Verification queue': 'library-queue', 'Public catalogue': 'library-catalogue', 'QR labels': 'library-qr', Archive: 'library-archive' },
  };
  return targets[role]?.[label] || null;
}
function Workspace({ role, title, subtitle, children, sidebar = [] }) {
  const [activeLabel, setActiveLabel] = useState(sidebar.find(item => item[2])?.[1] || '');
  const navigate = ([, label, , onClick]) => { setActiveLabel(label); if (onClick) onClick(); else scrollToWorkspaceSection(workspaceSectionTarget(role, label)); };
  return <div className="workspace-shell"><aside className="sidebar"><div className="sidebar-head"><span className="sidebar-mark"><ShieldCheck size={18} /></span><div><strong>{role === 'teacher' ? 'Supervisor' : role[0].toUpperCase() + role.slice(1)} panel</strong><small>Operations center</small></div></div><nav className="sidebar-nav">{sidebar.map(item => { const [Icon,label] = item; const active = activeLabel === label; return <button type="button" className={active ? 'active' : ''} key={label} onClick={() => navigate(item)} aria-current={active ? 'page' : undefined}><Icon size={16} />{label}</button>; })}</nav></aside><section className="workspace-main blueprint"><div className="workspace-head"><div><p className="eyebrow">{role === 'teacher' ? 'Review workspace' : 'Operations workspace'}</p><h1>{title}</h1><p>{subtitle}</p></div></div>{children}</section></div>;
}
function MetricCards({ items }) { return <div className="metric-grid">{items.map(([label,value,Icon]) => <div className="metric-card" key={label}><div className="metric-icon"><Icon size={16} /></div><small>{label}</small><strong>{value}</strong></div>)}</div>; }
function StudentProfileCard({ profile }) { const name = profile?.full_name || 'Student'; const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toUpperCase() || 'S'; return <section className="student-profile-card"><div className="student-profile-avatar">{profile?.avatar_url ? <img src={profile.avatar_url} alt="" /> : initials}</div><div className="student-profile-copy"><p className="eyebrow">Official student profile</p><h2>{name}</h2><div className="student-profile-meta"><span>{profile?.matric || 'Matric pending'}</span><span>{profile?.department || 'Department pending'}</span><span>{profile?.degree || 'Degree pending'}</span></div></div><span className="tag"><LockKeyhole size={12} />Registry verified</span></section>; }
function ContactDetails({ person, roleLabel = 'Supervisor' }) { return <div className="contact-details"><div className="contact-detail"><Mail size={14} /><span>{person?.email || 'Email not provided'}</span></div><div className="contact-detail"><Phone size={14} /><span>{person?.phone || 'Phone not provided'}</span></div><div className="contact-detail"><GraduationCap size={14} /><span>{person?.department || 'Department not assigned'}</span></div><small>{roleLabel}</small></div>; }
function SupervisorContactCard({ supervisor, missingCopy = 'No supervisor has been assigned yet. An administrator must assign one before your review can begin.', heading }) { const contactEditor = supervisor?._contactEditor; const title = heading || (supervisor?.role === 'teacher' ? 'Your supervisor profile' : 'Your assigned supervisor'); return <><section className={`surface supervisor-contact-card ${supervisor ? '' : 'is-missing'}`}><div className="surface-head"><div><p className="eyebrow">Academic support</p><h2>{supervisor ? title : 'Supervisor assignment required'}</h2><p>{supervisor ? 'Keep these official contact details available for questions and follow-up.' : missingCopy}</p></div><UserCheck size={18} color={supervisor ? '#065f46' : '#b45309'} /></div>{supervisor ? <div className="supervisor-contact-body"><ProfileAvatar name={supervisor.full_name} src={supervisor.avatar_url} size="avatar-medium" /><div><h3>{supervisor.full_name || 'Assigned supervisor'}</h3><ContactDetails person={supervisor} /></div></div> : <div className="assignment-warning"><UserCheck size={16} /><span>Pending admin assignment</span></div>}</section>{contactEditor && <ProfileContactEditor profile={supervisor} {...contactEditor} />}</>; }

function ProfileContactEditor({ profile, session, preview, onProfileUpdate, onToast }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ email: profile?.email || '', phone: profile?.phone || '' });
  useEffect(() => {
    if (open) setForm({ email: profile?.email || '', phone: profile?.phone || '' });
  }, [open, profile]);
  const save = async event => {
    event.preventDefault();
    const email = form.email.trim().toLowerCase();
    const phone = form.phone.trim();
    if (!email) { onToast('Enter a valid email address.'); return; }
    setSaving(true);
    try {
      if (preview) {
        onProfileUpdate({ ...profile, email, phone });
        setOpen(false);
        onToast('Preview contact details updated.');
        return;
      }
      if (!supabase || !session?.user?.id) throw new Error('Your session is not ready. Sign in again and retry.');
      let effectiveEmail = email;
      let emailConfirmationPending = false;
      if (email !== String(profile?.email || '').trim().toLowerCase()) {
        const { data: authData, error: authError } = await supabase.auth.updateUser({ email });
        if (authError) throw authError;
        effectiveEmail = authData.user?.email || email;
        emailConfirmationPending = effectiveEmail.toLowerCase() !== email;
      }
      const { data, error } = await supabase.from('profiles').update({ email: effectiveEmail, phone: phone || null }).eq('id', session.user.id).select('*').single();
      if (error) throw error;
      onProfileUpdate(data || { ...profile, email: effectiveEmail, phone: phone || null });
      setOpen(false);
      onToast(emailConfirmationPending ? 'Contact details saved. Confirm the new email address to finish changing it.' : 'Contact details updated.');
    } catch (error) {
      onToast(error.message || 'Contact details could not be updated.');
    } finally {
      setSaving(false);
    }
  };
  return <>
    <section className="surface profile-contact-editor">
      <div className="surface-head"><div><p className="eyebrow">Contact details</p><h2>Keep your contact details current</h2><p>Your full name and academic identity are managed by the institution.</p></div><PencilLine size={18} color="#065f46" /></div>
      <div className="profile-contact-summary"><ContactDetails person={profile} roleLabel={profile?.role === 'teacher' ? 'Supervisor account' : 'Student account'} /><button className="button button-primary button-small" type="button" onClick={() => setOpen(true)}><PencilLine size={14} />Edit contact info</button></div>
    </section>
    <Modal open={open} onClose={() => !saving && setOpen(false)} eyebrow="Profile settings" title="Edit contact info">
      <form className="form-grid" onSubmit={save}>
        <div className="field full"><label htmlFor="profile-full-name">Full name</label><input id="profile-full-name" value={profile?.full_name || ''} disabled readOnly /><span className="helper">Your name is verified and cannot be edited here.</span></div>
        <div className="field full"><label htmlFor="profile-email">Email address</label><input id="profile-email" type="email" required value={form.email} onChange={event => setForm({ ...form, email: event.target.value })} /></div>
        <div className="field full"><label htmlFor="profile-phone">Phone number</label><input id="profile-phone" type="tel" value={form.phone} onChange={event => setForm({ ...form, phone: event.target.value })} placeholder="0803 000 0000" /></div>
        <div className="modal-actions full"><button className="button button-ghost" type="button" disabled={saving} onClick={() => setOpen(false)}>Cancel</button><button className="button button-primary" disabled={saving}>{saving ? 'Saving...' : 'Save contact info'}</button></div>
      </form>
    </Modal>
  </>;
}

function StudentWorkspace({ profile, session, preview, onToast, onProfileUpdate }) {
  const revisionPreview = preview && previewAction === 'show_revision';
  const [project, setProject] = useState(revisionPreview ? { id: 'preview-project', title: 'Web-Based E-Voting System', degree: 'BSc', abstract: 'A final-year project workflow preview for supervisor review, library publication, payment clearance, and repository verification.', status: 'revision_requested', revision_note: 'Please replace the PDF with the corrected version and resubmit.' } : preview ? { id: 'preview-project', title: 'Web-Based E-Voting System', degree: 'BSc', abstract: 'A final-year project workflow preview for supervisor review, library publication, payment clearance, and repository verification.', status: 'published' } : null);
  const [payment, setPayment] = useState(preview ? { amount: 200000, paystack_reference: 'SPMS-PREVIEW-STUDENT', paid_at: new Date().toISOString() } : null);
  const [loading, setLoading] = useState(!preview);
  const [form, setForm] = useState({ title: 'Web-Based E-Voting System', degree: 'BSc', abstract: 'A final-year project workflow preview for supervisor review, library publication, payment clearance, and repository verification.' });
  const [file, setFile] = useState(null);
  const [receipt, setReceipt] = useState(preview && previewAction === 'show_receipt' ? { verification_code: 'SPMS-PREVIEW-RECEIPT', issued_at: new Date().toISOString(), profiles: { full_name: profile?.full_name, matric: profile?.matric } } : null);
  const [receiptQrUrl, setReceiptQrUrl] = useState('');
  const [supervisor, setSupervisor] = useState(preview ? { full_name: 'Dr. Sani Musa', email: 'teacher@kasu.edu.ng', phone: '+234 803 000 0000', department: 'Computer Science' } : null);
  const [clearanceFee, setClearanceFee] = useState(200000);
  const [maxPdfBytes, setMaxPdfBytes] = useState(DEFAULT_MAX_PDF_BYTES);
  const [submitting, setSubmitting] = useState(false);
  const [pendingVerification, setPendingVerification] = useState(null);
  const [activeSection, setActiveSection] = useState('student-overview');
  const pendingVerificationKey = session?.user?.id ? `spms:pending-clearance:${session.user.id}` : '';
  const navigate = targetId => { setActiveSection(targetId); scrollToWorkspaceSection(targetId); };
  useEffect(() => {
    if (preview || !session || !supabase) return undefined;
    Promise.all([
      supabase.from('projects').select('*').eq('student_id', session.user.id).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('payments').select('*').eq('student_id', session.user.id).eq('status', 'success').eq('transaction_type', 'clearance_fee').order('created_at', { ascending: false }).limit(1).maybeSingle(),
      loadSystemConfig(profile?.institution_id),
      supabase.from('clearance_receipts').select('*').eq('student_id', session.user.id).order('issued_at', { ascending: false }).limit(1).maybeSingle(),
      profile?.supervisor_id ? supabase.from('profiles').select('id,full_name,email,phone,department,avatar_url').eq('id', profile.supervisor_id).maybeSingle() : Promise.resolve({ data: null }),
    ]).then(([projectResult, paymentResult, configResult, receiptResult, supervisorResult]) => { setProject(projectResult.data || null); setPayment(paymentResult.data || null); setReceipt(receiptResult.data || null); setSupervisor(supervisorResult?.data || null); setClearanceFee(configResult?.clearance_fee_kobo || 200000); setMaxPdfBytes(Number(configResult?.max_pdf_size_bytes) || DEFAULT_MAX_PDF_BYTES); if (projectResult.data) setForm({ title: projectResult.data.title || '', degree: projectResult.data.degree || 'BSc', abstract: projectResult.data.abstract || '' }); }).catch(error => onToast(error.message || 'Student workspace could not be loaded.')).finally(() => setLoading(false));
    return undefined;
  }, [onToast, preview, session, profile]);
  useEffect(() => {
    if (preview || !pendingVerificationKey) return undefined;
    try {
      const saved = window.localStorage.getItem(pendingVerificationKey);
      if (saved) setPendingVerification(JSON.parse(saved));
    } catch (_) {
      setPendingVerification(null);
    }
    return undefined;
  }, [pendingVerificationKey, preview]);
  useEffect(() => { let active = true; let objectUrl = ''; if (!receipt?.qr_payload) { setReceiptQrUrl(''); return undefined; } fetchQrSvg(receipt.qr_payload).then(url => { objectUrl = url; if (active) setReceiptQrUrl(url); }).catch(() => { if (active) setReceiptQrUrl(''); }); return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); }; }, [receipt?.qr_payload]);
  const savePendingVerification = payload => {
    setPendingVerification(payload);
    if (!pendingVerificationKey) return;
    try { window.localStorage.setItem(pendingVerificationKey, JSON.stringify(payload)); } catch (_) { /* The in-memory state remains usable. */ }
  };
  const clearPendingVerification = () => {
    setPendingVerification(null);
    if (!pendingVerificationKey) return;
    try { window.localStorage.removeItem(pendingVerificationKey); } catch (_) { /* Ignore storage cleanup failures. */ }
  };
  const retryPendingVerification = async () => {
    if (!pendingVerification || submitting) return;
    setSubmitting(true);
    try {
      const { reference, ...metadata } = pendingVerification;
      const data = await retryPaymentVerification(reference, metadata);
      setPayment(data.payment || payment);
      setProject(data.project || project);
      clearPendingVerification();
      onToast(data.project ? 'Payment verified and thesis submitted for review.' : 'Payment verification completed. Refreshing your workspace.');
    } catch (error) {
      onToast(`Payment verification is still pending: ${error.message}`);
    } finally { setSubmitting(false); }
  };
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
            const pending = { reference, file_name: selectedFile.name, file_path: upload.data.path, title: form.title, abstract: form.abstract, degree: form.degree, course_id: profile?.course_id || null, file_size_bytes: selectedFile.size, mime_type: selectedFile.type || 'application/pdf' };
            savePendingVerification(pending);
            const { reference: pendingReference, ...metadata } = pending;
            const data = await retryPaymentVerification(pendingReference, metadata);
            clearPendingVerification();
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
  return <Workspace
    role="student"
    title="Your clearance workspace"
    subtitle="Submit once, follow every review stage, and keep your official receipt close."
    sidebar={[
      [GraduationCap, 'My workspace', activeSection === 'student-overview', () => navigate('student-overview')],
      [FileText, 'Submission', activeSection === 'student-submission', () => navigate('student-submission')],
      [CircleDollarSign, 'Payments', activeSection === 'student-payments', () => navigate('student-payments')],
      [ShieldCheck, 'Receipt', activeSection === 'student-receipt', () => navigate('student-receipt')],
    ]}
  >
    <div id="student-overview" className="workspace-section">
      <StudentProfileCard profile={profile} />
      <SupervisorContactCard supervisor={supervisor} />
      <ProfileContactEditor profile={profile} session={session} preview={preview} onProfileUpdate={onProfileUpdate} onToast={onToast} />
      <MetricCards items={[
        ['Workflow status', project ? project.status.replaceAll('_', ' ') : pendingVerification ? 'Payment verification pending' : 'Not started', FileCheck2],
        ['Clearance fee', formatNaira(clearanceFee), CircleDollarSign],
        ['Submission', project ? 'Received' : pendingVerification ? 'Verification pending' : 'Awaiting upload', FileText],
        ['Receipt', project?.status === 'cleared' || receipt ? 'Ready' : 'After clearance', Archive],
      ]} />
    </div>
    <div className="workspace-grid">
      <section className="surface span-two workspace-section" id="student-submission">
        <div className="surface-head"><div><h2>Submission details</h2><p>Capture the metadata your supervisor and library will verify.</p></div>{project && <StatusChip status={project.status} />}</div>
        {project?.status === 'revision_requested' && <div className="revision-banner"><strong>Revision Required</strong><span>Upload the corrected PDF and resubmit without paying the clearance fee again.</span></div>}
        {pendingVerification && <div className="pending-payment-banner"><div><strong>Payment verification pending</strong><span>Your PDF is safely uploaded. Retry verification with the same Paystack reference; you will not be charged again.</span></div><button className="button button-primary button-small" type="button" onClick={retryPendingVerification} disabled={submitting}><RefreshCw size={14} />{submitting ? 'Retrying...' : 'Retry verification'}</button></div>}
        <form className="form-grid" onSubmit={submit}>
          <div className="field full"><label htmlFor="project-title-input">Project title</label><input id="project-title-input" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></div>
          <div className="field"><label htmlFor="project-degree-input">Degree</label><select id="project-degree-input" value={form.degree} onChange={e => setForm({ ...form, degree: e.target.value })}><option>BSc</option><option>PGD</option><option>MSc</option><option>PhD</option></select></div>
          <div className="field"><label htmlFor="thesis-pdf-input">Thesis PDF</label><input id="thesis-pdf-input" type="file" accept="application/pdf,.pdf" onChange={e => { const selected = e.target.files?.[0] || null; setFile(selected); const error = validateThesisFile(selected, maxPdfBytes); if (error) onToast(error); }} /><span className="helper">PDF only. Maximum {Math.round(maxPdfBytes / (1024 * 1024))} MB.</span></div>
          <div className="field full"><label htmlFor="project-abstract-input">Abstract</label><textarea id="project-abstract-input" value={form.abstract} onChange={e => setForm({ ...form, abstract: e.target.value })} /><span className="helper">Minimum 50 characters. This abstract becomes part of the public catalog after library approval.</span></div>
          <div className="modal-actions field full"><button className="button button-primary" id="pay-btn" disabled={submitting || Boolean(pendingVerification) || Boolean(project && ['published', 'cleared'].includes(project.status))}>{project?.status === 'revision_requested' && payment ? <><RefreshCw size={15} />{submitting ? 'Submitting revision...' : 'Upload Revision & Resubmit'}</> : payment ? <><Check size={15} />Submission successful</> : pendingVerification ? <><RefreshCw size={15} />Payment verification pending</> : <><CircleDollarSign size={15} />{submitting ? 'Opening secure checkout...' : 'Pay & submit thesis'}</>}</button></div>
        </form>
      </section>
      <section className="surface workspace-section">
        <div className="surface-head"><div><h2>Current status</h2><p>Live workflow checkpoints.</p></div><LockKeyhole size={17} color="#065f46" /></div>
        {project ? <div className="status-panel"><h3>{project.title}</h3><StatusChip status={project.status} /><div className="progress-track"><div className="progress-fill" style={{ width: `${['submitted', 'supervisor_review', 'revision_requested'].includes(project.status) ? 34 : project.status === 'supervisor_approved' ? 62 : project.status === 'library_review' ? 80 : 100}%` }} /></div>{project.revision_note && <p className="helper"><strong>Supervisor note:</strong> {project.revision_note}</p>}</div> : pendingVerification ? <div className="status-panel"><h3>Awaiting payment confirmation</h3><p className="helper">The uploaded PDF remains private while the server verifies the successful Paystack payment.</p><button className="button button-primary button-small" type="button" onClick={retryPendingVerification} disabled={submitting}><RefreshCw size={14} />Retry verification</button></div> : <EmptyState icon={FileText} title="No submission yet" copy="Complete the form to start your clearance journey." />}
      </section>
      <section className="surface workspace-section" id="student-payments">
        <div id="student-receipt" className="workspace-anchor" aria-hidden="true" />
        <div className="surface-head"><div><h2>Payment evidence</h2><p>Every successful payment is tied to your account.</p></div><CircleDollarSign size={17} color="#065f46" /></div>
        {payment ? <div className="receipt" id="receipt-section">
          <h3>{previewAction === 'show_receipt' || receipt || project?.status === 'cleared' ? 'Digital Clearance Receipt' : 'Payment captured'}</h3>
          <dl><dt>Reference</dt><dd>{payment.paystack_reference}</dd><dt>Amount</dt><dd>{formatNaira(payment.amount)}</dd><dt>Date</dt><dd>{displayDate(payment.paid_at)}</dd></dl>
          {receiptQrUrl && <div className="qr-preview"><img src={receiptQrUrl} alt="Clearance receipt verification QR code" /><span className="helper">Scan to verify this clearance receipt.</span></div>}
          {(previewAction === 'show_receipt' || ['published', 'cleared'].includes(project?.status)) && (receipt ? <button className="button button-primary" style={{ marginTop: '1rem' }} onClick={() => downloadReceiptPdf(receipt, project, payment, profile)}><Download size={15} />Download receipt PDF</button> : <button className="button button-primary" style={{ marginTop: '1rem' }} onClick={generateReceipt}>Issue digital receipt</button>)}
        </div> : pendingVerification ? <div className="status-panel"><h3>Payment recorded, verification pending</h3><p className="helper">No second payment is required. The same reference will be retried against the uploaded PDF.</p><button className="button button-primary button-small" type="button" onClick={retryPendingVerification} disabled={submitting}><RefreshCw size={14} />Retry verification</button></div> : <EmptyState icon={CircleDollarSign} title="No payment yet" copy="The fee is initialized securely on the server when you submit." />}
      </section>
    </div>
  </Workspace>;
}

function TeacherWorkspace({ profile, session, preview, onToast, onProfileUpdate }) {
  const [projects, setProjects] = useState(preview ? demoReviewProjects : []);
  const [students, setStudents] = useState(preview ? [{ id: 'preview-student', full_name: 'Musa Abdullahi', matric: 'KASU/SCI/20/123', email: 'student@kasu.edu.ng', phone: '+234 801 000 0000', department: 'Computer Science' }] : []);
  const [loading, setLoading] = useState(!preview);
  const [selected, setSelected] = useState(null);
  const [comment, setComment] = useState(preview && previewAction === 'open_review' ? 'Preview approval note for automated supervisor interaction coverage.' : '');
  const [activeSection, setActiveSection] = useState('teacher-assigned');
  const navigate = targetId => { setActiveSection(targetId); scrollToWorkspaceSection(targetId); };
  const canReview = status => ['submitted', 'supervisor_review', 'revision_requested'].includes(status);
  useEffect(() => {
    if (preview || !session || !supabase) return undefined;
    if (!profile?.institution_id) { setProjects([]); setLoading(false); onToast('Your supervisor account is not linked to an institution.'); return undefined; }
    Promise.all([
      supabase.from('projects').select('*, profiles!projects_student_id_fkey(full_name,matric,email,phone,department,avatar_url)').eq('institution_id', profile.institution_id).eq('supervisor_id', session.user.id).order('created_at', { ascending: false }),
      supabase.from('profiles').select('id,full_name,email,phone,matric,department,avatar_url,supervisor_id').eq('institution_id', profile.institution_id).eq('role', 'student').eq('supervisor_id', session.user.id).order('full_name'),
    ]).then(([projectsResult, studentsResult]) => { if (projectsResult.error) throw projectsResult.error; if (studentsResult.error) throw studentsResult.error; setProjects((projectsResult.data || []).map(item => ({ ...item, author: item.profiles?.full_name, matric: item.profiles?.matric, dept: item.profiles?.department, isDemo: false }))); setStudents(studentsResult.data || []); }).catch(error => { setProjects([]); setStudents([]); onToast(error.message || 'Supervisor queue could not be loaded.'); }).finally(() => setLoading(false));
    return undefined;
  }, [onToast, preview, session, profile]);
  useEffect(() => { if (preview && previewAction === 'open_review') setSelected(projects[0]); }, [preview, projects]);
  const review = async decision => {
    if (!selected) return;
    if (preview || selected.isDemo) { onToast(decision === 'approve' ? 'Preview project approved.' : 'Preview revision request saved.'); setSelected(null); return; }
    if (!canReview(selected.status)) { setSelected(null); onToast('This project has already moved past supervisor review. Refresh the queue to see the latest status.'); return; }
    try { await invoke('project-workflow', { action: 'supervisor_decision', project_id: selected.id, decision, comment }); setProjects(items => items.map(item => item.id === selected.id ? { ...item, status: decision === 'approve' ? 'supervisor_approved' : 'revision_requested' } : item)); setSelected(null); onToast(decision === 'approve' ? 'Project approved and routed to the library.' : 'Revision request sent to the student.'); } catch (error) { const statusMatch = error.message?.match(/Current status:\s*([a-z_]+)/i); if (statusMatch) { const latestStatus = statusMatch[1].toLowerCase(); setProjects(items => items.map(item => item.id === selected.id ? { ...item, status: latestStatus } : item)); } setSelected(null); onToast(statusMatch ? 'This project has already moved past supervisor review. The queue was refreshed.' : error.message); }
  };
  if (loading) return <PageSkeleton role="teacher" />;
  return <Workspace role="teacher" title="Supervisor review queue" subtitle="Review assigned research, preview private PDFs, and leave auditable decisions." sidebar={[[Users,'Assigned students',activeSection === 'teacher-assigned',() => navigate('teacher-assigned')],[FileCheck2,'Review history',activeSection === 'teacher-history',() => navigate('teacher-history')],[Settings2,'Preferences',activeSection === 'teacher-preferences',() => navigate('teacher-preferences')]]}><div className="workspace-section" id="teacher-assigned"><MetricCards items={[["Awaiting review", projects.filter(item => item.status === 'supervisor_review').length, FileCheck2],["Revision requests", projects.filter(item => item.status === 'revision_requested').length, RefreshCw],["Approved", projects.filter(item => item.status === 'supervisor_approved').length, CheckCircle2],["Assigned students", students.length, Users]]} /><SupervisorContactCard supervisor={profile} missingCopy="Your supervisor profile is managed by the institution." /><section className="surface"><div className="surface-head"><div><h2>Assigned student directory</h2><p>Contact details and academic identity for every student assigned to you.</p></div><span className="tag"><LockKeyhole size={12} />RLS protected</span></div>{students.length ? <div className="contact-directory">{students.map(student => <div className="contact-directory-item" key={student.id}><div className="identity-cell"><ProfileAvatar name={student.full_name} src={student.avatar_url} /><div><strong>{student.full_name || 'Student'}</strong><span className="helper">{student.matric || 'Matric pending'} · {student.department || 'Department pending'}</span></div></div><ContactDetails person={student} roleLabel="Assigned student" /></div>)}</div> : <EmptyState icon={Users} title="No assigned students" copy="Students assigned by an administrator will appear here." />}</section><section className="surface"><div className="surface-head"><div><h2>Assigned projects</h2><p>Private files are opened through short-lived signed links.</p></div><span className="tag"><LockKeyhole size={12} />RLS protected</span></div>{projects.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Student</th><th>Contact</th><th>Project</th><th>Status</th><th>Action</th></tr></thead><tbody>{projects.map(item => <tr key={item.id}><td><div className="identity-cell"><ProfileAvatar name={item.author} src={item.profiles?.avatar_url} /><div><strong>{item.author || 'Student'}</strong><br /><span className="helper">{item.matric || '—'}</span></div></div></td><td><span className="helper">{item.profiles?.email || '—'}<br />{item.profiles?.phone || 'Phone not provided'}</span></td><td>{item.title}</td><td><StatusChip status={item.status} /></td><td>{canReview(item.status) ? <button className="button button-primary button-small" onClick={() => { setSelected(item); setComment(''); }}>Review</button> : <span className="tag"><LockKeyhole size={12} />Read only</span>}</td></tr>)}</tbody></table></div> : <EmptyState icon={FileText} title="No assigned projects" copy="New submissions will appear here when they are assigned to you." />}</section></div><section className="surface workspace-section" id="teacher-history"><div className="surface-head"><div><h2>Review history</h2><p>Recent decisions remain visible for audit and follow-up.</p></div><FileCheck2 size={17} color="#065f46" /></div>{projects.filter(item => item.status !== 'supervisor_review').length ? <div className="queue-list">{projects.filter(item => item.status !== 'supervisor_review').map(item => <div className="queue-item" key={`history-${item.id}`}><div><h3>{item.title}</h3><p>{item.author || 'Student'} · {item.status.replaceAll('_', ' ')}</p></div><StatusChip status={item.status} /></div>)}</div> : <EmptyState icon={FileCheck2} title="No decisions yet" copy="Approved projects and revision requests will appear here." />}</section><section className="surface workspace-section" id="teacher-preferences"><div className="surface-head"><div><p className="eyebrow">Workspace settings</p><h2>Preferences</h2><p>Your supervisor workspace context.</p></div><Settings2 size={17} color="#065f46" /></div><div className="queue-list"><div className="queue-item"><div><h3>Department</h3><p>{profile?.department || 'Computer Science'}</p></div><span className="tag">Institution managed</span></div><div className="queue-item"><div><h3>Private previews</h3><p>Signed PDF links expire automatically after five minutes.</p></div><LockKeyhole size={17} color="#065f46" /></div></div></section><Modal open={Boolean(selected)} onClose={() => setSelected(null)} eyebrow="Supervisor review" title={selected?.title || ''} wide><div className="modal-body-grid"><div><div className="status-panel"><div className="identity-cell"><ProfileAvatar name={selected?.author} src={selected?.profiles?.avatar_url} size="avatar-medium" /><div><h3>{selected?.author || 'Student'}</h3><p className="helper">{selected?.matric} · {selected?.dept || 'Computer Science'} · {selected?.degree}</p><ContactDetails person={selected?.profiles} roleLabel="Student contact" /></div></div><StatusChip status={selected?.status} /></div><p className="helper" style={{ marginTop: '1rem', lineHeight: 1.65 }}>{selected?.abstract}</p><div className="field" style={{ marginTop: '1rem' }}><label htmlFor="modal-review-comment">Decision comment</label><textarea id="modal-review-comment" value={comment} onChange={e => setComment(e.target.value)} placeholder="Add an approval note or explain the revision needed." /></div></div><div><p className="eyebrow">Private PDF preview</p>{selected?.isDemo ? <div className="empty-state surface"><FileText size={23} color="#065f46" /><h3>Preview unavailable in demo mode</h3><p>Real projects open through a five-minute signed storage URL.</p></div> : <PdfPreview path={selected?.file_path} />}</div></div><div className="modal-actions"><button className="button button-ghost" disabled={!canReview(selected?.status)} onClick={() => review('request_revision')}><PencilLine size={15} />Request revision</button><button className="button button-primary" disabled={!canReview(selected?.status)} onClick={() => review('approve')}><Check size={15} />Approve Project</button></div></Modal></Workspace>;
}

function PdfPreview({ path }) { const [url, setUrl] = useState(''); const [error, setError] = useState(''); useEffect(() => { if (!path) return undefined; signedPdfUrl(path).then(setUrl).catch(err => setError(err.message)); return undefined; }, [path]); if (error || !url) return <div className="empty-state surface"><FileText size={22} color="#065f46" /><h3>{error ? 'Preview unavailable' : 'Preparing secure preview...'}</h3><p>{error || 'Creating a short-lived private link.'}</p></div>; return <iframe className="pdf-frame" title="Private thesis PDF preview" src={url} />; }

function LibraryWorkspace({ profile, session, preview, onToast }) {
  const [projects, setProjects] = useState(preview ? demoReviewProjects.filter(item => ['supervisor_approved','published'].includes(item.status)) : []);
  const [loading, setLoading] = useState(!preview);
  const [selected, setSelected] = useState(null);
  const [form, setForm] = useState({ shelf_number: 'KASU-CS-001', doi: '', comment: '' });
  const [qrUrl, setQrUrl] = useState('');
  const [queueQuery, setQueueQuery] = useState('');
  const [queueStatus, setQueueStatus] = useState('all');
  const [activeSection, setActiveSection] = useState('library-queue');
  const navigate = targetId => { setActiveSection(targetId); scrollToWorkspaceSection(targetId); };
  useEffect(() => { if (preview && previewAction === 'open_catalog_record' && projects.length) { setSelected(projects[0]); setForm(current => ({ ...current, comment: 'Preview catalog note for automated library interaction coverage.' })); } }, [preview, projects]);
  useEffect(() => { if (preview || !session || !supabase) return undefined; if (!profile?.institution_id) { setProjects([]); setLoading(false); onToast('Your library account is not linked to an institution.'); return undefined; } supabase.from('projects').select('*, profiles!projects_student_id_fkey(full_name,matric)').eq('institution_id', profile.institution_id).in('status', ['supervisor_approved','library_review','published','cleared']).order('created_at', { ascending: false }).then(({ data, error }) => { if (error) throw error; setProjects(data || []); }).catch(error => { setProjects([]); onToast(error.message || 'Library queue could not be loaded.'); }).finally(() => setLoading(false)); return undefined; }, [onToast, preview, session, profile]);
  useEffect(() => { let active = true; let objectUrl = ''; if (!selected?.qr_payload) { setQrUrl(''); return undefined; } fetchQrSvg(selected.qr_payload).then(url => { objectUrl = url; if (active) setQrUrl(url); }).catch(() => { if (active) setQrUrl(''); }); return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); }; }, [selected?.qr_payload]);
  const verifyMetadata = async () => {
    if (!selected) return;
    if (preview || selected.isDemo) {
      const verified = { ...selected, status: 'library_review', metadata_verified_at: new Date().toISOString() };
      setProjects(items => items.map(item => item.id === selected.id ? verified : item));
      setSelected(verified);
      onToast('Metadata verified. The record is ready for QR publication.');
      return;
    }
    try {
      const data = await invoke('project-workflow', { action: 'library_verify', project_id: selected.id, comment: form.comment });
      setProjects(items => items.map(item => item.id === selected.id ? { ...item, ...data.project } : item));
      setSelected(data.project || { ...selected, status: 'library_review', metadata_verified_at: new Date().toISOString() });
      onToast('Metadata verified. Generate the QR label and publish when ready.');
    } catch (error) { onToast(error.message); }
  };
  const publish = async () => { if (!selected) return; if (preview || selected.isDemo) { onToast('Preview catalog record verified and published.'); setSelected(null); return; } try { const data = await invoke('project-workflow', { action: 'library_publish', project_id: selected.id, shelf_number: form.shelf_number, doi: form.doi, comment: form.comment }); setProjects(items => items.map(item => item.id === selected.id ? { ...item, ...data.project, status: 'published' } : item)); setSelected(data.project || { ...selected, status: 'published' }); onToast('Project published to the public catalog and QR code generated.'); } catch (error) { onToast(error.message); } };
  const queueProjects = projects.filter(item => ['supervisor_approved', 'library_review'].includes(item.status));
  const filteredQueueProjects = queueProjects.filter(item => (queueStatus === 'all' || item.status === queueStatus) && [item.title, item.author, item.profiles?.full_name, item.dept, item.department, item.degree].join(' ').toLowerCase().includes(queueQuery.trim().toLowerCase()));
  const catalogueProjects = projects.filter(item => ['published', 'cleared'].includes(item.status));
  const qrProjects = catalogueProjects.filter(item => item.qr_payload || item.shelf_number);
  const archiveProjects = projects.filter(item => item.status === 'cleared');
  const openRecord = item => { setSelected(item); setForm({ shelf_number: item.shelf_number || `KASU-CS-${String(projects.indexOf(item) + 1).padStart(3, '0')}`, doi: item.doi || '', comment: '' }); };
  if (loading) return <PageSkeleton role="library" />;
  return <Workspace role="library" title="Library verification desk" subtitle="Verify metadata, assign shelf records, and publish approved research." sidebar={[[Library, 'Verification queue', activeSection === 'library-queue', () => navigate('library-queue')], [BookOpen, 'Public catalogue', activeSection === 'library-catalogue', () => navigate('library-catalogue')], [QrCode, 'QR labels', activeSection === 'library-qr', () => navigate('library-qr')], [Archive, 'Archive', activeSection === 'library-archive', () => navigate('library-archive')]]}>
    <MetricCards items={[["Ready for verification", queueProjects.length, FileCheck2], ["Published records", catalogueProjects.length, BookOpen], ["Shelf labels", qrProjects.length, QrCode], ["Privacy", 'Private PDFs', LockKeyhole]]} />
    <section className="surface workspace-section" id="library-queue"><div className="surface-head"><div><h2>Verification queue</h2><p>Filter supervisor-approved projects, verify their metadata, then publish a protected catalog record.</p></div><span className="tag"><QrCode size={12} />QR ready</span></div><div className="table-tools"><SearchBox value={queueQuery} onChange={setQueueQuery} placeholder="Filter title, student, or department" /><select id="library-status-filter" value={queueStatus} onChange={event => setQueueStatus(event.target.value)} aria-label="Library queue status"><option value="all">All queue states</option><option value="supervisor_approved">Needs metadata verification</option><option value="library_review">Ready to publish</option></select></div>{filteredQueueProjects.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Research</th><th>Author</th><th>Department</th><th>Status</th><th>Action</th></tr></thead><tbody>{filteredQueueProjects.map(item => <tr key={item.id}><td><strong>{item.title}</strong><br /><span className="helper">{item.degree}</span></td><td><div className="identity-cell"><ProfileAvatar name={item.author || item.profiles?.full_name} src={item.profiles?.avatar_url} /><span>{item.author || item.profiles?.full_name || 'Student'}</span></div></td><td>{item.dept || item.department || 'Computer Science'}</td><td><StatusChip status={item.status} /></td><td><button className="button button-primary button-small" type="button" onClick={() => openRecord(item)}>Open record</button></td></tr>)}</tbody></table></div> : <EmptyState icon={Library} title={queueProjects.length ? 'No matching queue records' : 'Queue is clear'} copy={queueProjects.length ? 'Try a different title, student, department, or status filter.' : 'Supervisor-approved projects will arrive here for metadata verification.'} />}</section>
    <section className="surface workspace-section" id="library-catalogue"><div className="surface-head"><div><h2>Public catalogue</h2><p>Published metadata is discoverable while thesis files remain private.</p></div><BookOpen size={17} color="#065f46" /></div><DataTable columns={['Title', 'Degree', 'Department', 'Shelf', 'Published']} rows={catalogueProjects.map(item => [item.title, item.degree || '—', item.dept || item.department_name || '—', item.shelf_number || 'Pending', displayDate(item.published_at || item.updated_at)])} empty="No catalogue records published yet." /></section>
    <section className="surface workspace-section" id="library-qr"><div className="surface-head"><div><h2>QR labels</h2><p>Open a published record to preview or refresh its verification label.</p></div><QrCode size={17} color="#065f46" /></div>{qrProjects.length ? <div className="queue-list">{qrProjects.map(item => <div className="queue-item" key={`qr-${item.id}`}><div><h3>{item.title}</h3><p>{item.shelf_number || 'Shelf number pending'} · {item.qr_payload ? 'Verification payload ready' : 'QR pending'}</p></div><button className="button button-ghost button-small" type="button" onClick={() => openRecord(item)}><QrCode size={14} />Open label</button></div>)}</div> : <EmptyState icon={QrCode} title="No QR labels yet" copy="Publish a verified project to create its public verification label." />}</section>
    <section className="surface workspace-section" id="library-archive"><div className="surface-head"><div><h2>Archive</h2><p>Cleared records remain available for institutional audit and retrieval.</p></div><Archive size={17} color="#065f46" /></div><DataTable columns={['Title', 'Degree', 'Shelf', 'Cleared']} rows={archiveProjects.map(item => [item.title, item.degree || '—', item.shelf_number || '—', displayDate(item.updated_at)])} empty="No cleared records in the archive." /></section>
    <Modal open={Boolean(selected)} onClose={() => setSelected(null)} eyebrow="Catalog record" title={selected?.title || ''} wide><div className="modal-body-grid"><div><div className="status-panel"><h3>Metadata verification</h3><p className="helper">{selected?.abstract}</p><StatusChip status={selected?.status} /></div><div className="form-grid" style={{ marginTop: '1rem' }}><div className="field"><label htmlFor="shelf-number">Shelf number</label><input id="shelf-number" value={form.shelf_number} onChange={e => setForm({ ...form, shelf_number: e.target.value })} /></div><div className="field"><label htmlFor="doi">DOI or catalogue ID</label><input id="doi" value={form.doi} onChange={e => setForm({ ...form, doi: e.target.value })} placeholder="Optional" /></div><div className="field full"><label htmlFor="lib-comment-input">Library note</label><textarea id="lib-comment-input" value={form.comment} onChange={e => setForm({ ...form, comment: e.target.value })} placeholder="Record the verification note." /></div></div></div><div className="surface"><p className="eyebrow">Publication checklist</p><div className="queue-list">{['Metadata complete', 'Abstract is discoverable', 'Private PDF remains protected', 'QR verification payload ready'].map(item => <div className="queue-item" key={item}><span className="helper">{item}</span><CheckCircle2 size={17} color="#059669" /></div>)}</div>{qrUrl && <div className="qr-preview"><img src={qrUrl} alt="Project verification QR code" /><span className="helper">Scan to verify this public catalog record.</span></div>}</div></div><div className="modal-actions"><button className="button button-ghost" type="button" onClick={() => setSelected(null)}>Cancel</button>{selected?.status === 'supervisor_approved' && <button className="button button-ghost" type="button" onClick={verifyMetadata}><CheckCircle2 size={15} />Verify metadata</button>}<button className="button button-primary" type="button" onClick={publish}><QrCode size={15} />{preview ? 'Generate QR & Publish' : selected?.status === 'published' ? 'Refresh QR' : 'Generate QR & Publish'}</button></div></Modal>
  </Workspace>;
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
    if (!profile?.institution_id) {
      setLoading(false);
      onToast('Your admin account is not linked to an institution.');
      return;
    }
    const activeInstitutionId = profile.institution_id;
    setLoading(true);
    const institutionQuery = supabase.from('institutions').select('*').eq('id', activeInstitutionId).maybeSingle();
    const configQuery = supabase.from('system_configs').select('*').eq('institution_id', activeInstitutionId).maybeSingle();
    const scheduleQuery = supabase.from('report_schedules').select('*').eq('institution_id', activeInstitutionId).order('created_at', { ascending: false });
    const reportQuery = supabase.from('generated_reports').select('*').eq('institution_id', activeInstitutionId).order('generated_at', { ascending: false }).limit(20);
    const studentsQuery = supabase.from('profiles').select('id,full_name,email,matric,department,department_id,created_at').eq('institution_id', activeInstitutionId).eq('role', 'student').order('created_at', { ascending: false }).limit(100);
    const projectQuery = supabase.from('projects').select('id,title,status,degree,created_at,updated_at,profiles!projects_student_id_fkey(full_name,matric),departments(name)').eq('institution_id', activeInstitutionId).order('created_at', { ascending: false }).limit(100);
    const receiptQuery = supabase.from('clearance_receipts').select('id,project_id,student_id,verification_code,qr_payload,issued_at,projects(title),profiles!clearance_receipts_student_id_fkey(full_name,matric)').eq('projects.institution_id', activeInstitutionId).order('issued_at', { ascending: false }).limit(100);
    const departmentQuery = supabase.from('departments').select('id,name,code,faculty_id,faculties(name)').eq('institution_id', activeInstitutionId).order('name');
    const courseQuery = supabase.from('courses').select('id,name,code,level,department_id,departments(name)').eq('institution_id', activeInstitutionId).order('name');
    const facultyQuery = supabase.from('faculties').select('id,name,college_id,colleges(name)').eq('institution_id', activeInstitutionId).order('name');
    const collegeQuery = supabase.from('colleges').select('id,name').eq('institution_id', activeInstitutionId).order('name');
    try {
      const [overviewResult, studentsResult, projectResult, paymentResult, guestOrderResult, receiptResult, departmentResult, courseResult, facultyResult, collegeResult, institutionResult, configResult, schedulesResult, reportResult] = await Promise.all([
        supabase.from('admin_overview').select('*').maybeSingle(),
        studentsQuery,
        projectQuery,
        // Payments inherit tenant scoping through the student profile RLS policy;
        // the table itself intentionally has no duplicated institution column.
        supabase.from('payments').select('id,project_id,amount,currency,status,transaction_type,paystack_reference,created_at,paid_at,payer_id,profiles!payments_student_id_fkey!inner(institution_id)').eq('profiles.institution_id', activeInstitutionId).order('created_at', { ascending: false }).limit(100),
        supabase.from('guest_download_orders').select('id,amount,currency,status,paystack_reference,created_at,unlocked_at,email,project_id,metadata').eq('institution_id', activeInstitutionId).order('created_at', { ascending: false }).limit(100),
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
      const failedQuery = [overviewResult, studentsResult, projectResult, paymentResult, guestOrderResult, receiptResult, departmentResult, courseResult, facultyResult, collegeResult, institutionResult, configResult, schedulesResult, reportResult].find(result => result?.error);
      if (failedQuery?.error) throw failedQuery.error;
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
    {section === 'payments' && <section className="surface"><SectionHeader eyebrow="Finance evidence" title="Payment ledger" copy="Clearance payments and authenticated repository downloads with references for reconciliation." /><DataTable columns={['Reference', 'Type', 'Amount', 'Status', 'Created', 'Receipt']} rows={[...payments.map(item => { const receipt = receipts.find(record => record.project_id === item.project_id); return [item.paystack_reference || '—', item.transaction_type?.replaceAll('_', ' ') || '—', formatNaira(item.amount), item.status || '—', displayDate(item.created_at), receipt ? <button className="button button-ghost button-small" onClick={() => setSelectedReceipt(receipt)}>View</button> : '—']; }), ...guestOrders.map(item => [item.paystack_reference || '—', 'legacy repository download', formatNaira(item.amount), item.status || '—', displayDate(item.created_at), '—'])]} empty="No payment records found." /><Modal open={Boolean(selectedReceipt)} onClose={() => setSelectedReceipt(null)} eyebrow="Clearance evidence" title={selectedReceipt?.verification_code || 'Receipt'}><div className="receipt"><h3>{selectedReceipt?.projects?.title || 'Clearance receipt'}</h3><dl><dt>Student</dt><dd>{selectedReceipt?.profiles?.full_name || '—'}</dd><dt>Matric</dt><dd>{selectedReceipt?.profiles?.matric || '—'}</dd><dt>Issued</dt><dd>{displayDate(selectedReceipt?.issued_at)}</dd><dt>Verification code</dt><dd>{selectedReceipt?.verification_code || '—'}</dd></dl><p className="helper">This receipt includes a QR payload that can be checked through the public verification endpoint.</p></div><div className="modal-actions"><button className="button button-ghost" onClick={() => setSelectedReceipt(null)}>Close</button>{selectedReceipt && <button className="button button-primary" onClick={() => downloadReceiptPdf(selectedReceipt, selectedReceipt.projects, payments.find(item => item.project_id === selectedReceipt.project_id), selectedReceipt.profiles)}><Download size={15} />Download receipt PDF</button>}</div></Modal></section>}
    {section === 'reports' && <AdminReports schedules={schedules} generatedReports={generatedReports} schedule={schedule} setSchedule={setSchedule} createSchedule={createSchedule} generateReport={generateReport} runDue={runDue} />}
    {section === 'settings' && <AdminSettings institution={institution} settings={settings} onInstitutionChange={updateInstitution} onSettingsChange={updateSettings} onSave={saveSettings} saving={saving} />}
  </Workspace>;
}

function DataTable({ columns, rows, empty }) { return rows.length ? <div className="table-wrap"><table className="data-table"><thead><tr>{columns.map(column => <th key={column}>{column}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div> : <EmptyState icon={Archive} title={empty} copy="New records will appear here as the workflow is used." />; }

function HierarchyManager({ colleges, faculties, departments, courses, newCollege, setNewCollege, newFaculty, setNewFaculty, newDepartment, setNewDepartment, newCourse, setNewCourse, addHierarchy }) {
 return <section className="surface"><SectionHeader eyebrow="Academic structure" title="Colleges, faculties, departments, and courses" copy="Maintain the academic hierarchy used for student identity, supervisor matching, project metadata, and reports." /><div className="hierarchy-forms"><form className="inline-form" onSubmit={event => { event.preventDefault(); addHierarchy('colleges', { name: newCollege }); }}><label htmlFor="new-college">College</label><input id="new-college" value={newCollege} onChange={event => setNewCollege(event.target.value)} placeholder="College name" /><button className="button button-primary button-small"><Plus size={14} />Add</button></form><form className="inline-form" onSubmit={event => { event.preventDefault(); addHierarchy('faculties', newFaculty); }}><label htmlFor="new-faculty">Faculty</label><input id="new-faculty" value={newFaculty.name} onChange={event => setNewFaculty({ ...newFaculty, name: event.target.value })} placeholder="Faculty name" /><select value={newFaculty.college_id} onChange={event => setNewFaculty({ ...newFaculty, college_id: event.target.value })} aria-label="College for new faculty"><option value="">College</option>{colleges.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select><button className="button button-primary button-small"><Plus size={14} />Add</button></form><form className="inline-form" onSubmit={event => { event.preventDefault(); addHierarchy('departments', newDepartment); }}><label htmlFor="new-department">Department</label><input id="new-department" value={newDepartment.name} onChange={event => setNewDepartment({ ...newDepartment, name: event.target.value })} placeholder="Department name" /><input value={newDepartment.code} onChange={event => setNewDepartment({ ...newDepartment, code: event.target.value })} placeholder="Code" aria-label="Department code" /><select value={newDepartment.faculty_id} onChange={event => setNewDepartment({ ...newDepartment, faculty_id: event.target.value })} aria-label="Faculty for new department"><option value="">Faculty</option>{faculties.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select><button className="button button-primary button-small"><Plus size={14} />Add</button></form><form className="inline-form" onSubmit={event => { event.preventDefault(); addHierarchy('courses', newCourse); }}><label htmlFor="new-course">Course</label><input id="new-course" value={newCourse.name} onChange={event => setNewCourse({ ...newCourse, name: event.target.value })} placeholder="Course name" /><input value={newCourse.code} onChange={event => setNewCourse({ ...newCourse, code: event.target.value })} placeholder="Course code" aria-label="Course code" /><select value={newCourse.level} onChange={event => setNewCourse({ ...newCourse, level: event.target.value })} aria-label="Course level"><option value="">Level</option><option value="Undergraduate">Undergraduate</option><option value="Postgraduate">Postgraduate</option><option value="Professional">Professional</option></select><select value={newCourse.department_id} onChange={event => setNewCourse({ ...newCourse, department_id: event.target.value })} aria-label="Department for new course"><option value="">Department</option>{departments.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select><button className="button button-primary button-small"><Plus size={14} />Add</button></form></div><div className="hierarchy-grid"><div><h3>Colleges</h3>{colleges.map(item => <div className="queue-item" key={item.id}><span>{item.name}</span></div>)}</div><div><h3>Faculties</h3>{faculties.map(item => <div className="queue-item" key={item.id}><span>{item.name}</span><small>{item.colleges?.name || 'College not mapped'}</small></div>)}</div><div><h3>Departments</h3>{departments.map(item => <div className="queue-item" key={item.id}><span>{item.name}</span><small>{item.code || 'No code'} · {item.faculties?.name || 'Faculty not mapped'}</small></div>)}</div><div><h3>Courses</h3>{courses.map(item => <div className="queue-item" key={item.id}><span>{item.code} · {item.name}</span><small>{item.level || 'Level not set'} · {item.departments?.name || 'Department not mapped'}</small></div>)}</div></div></section>;
}

function AdminSupervisorQueue({ profile, onToast }) {
  const [queue, setQueue] = useState([]);
  const [supervisors, setSupervisors] = useState([]);
  const [students, setStudents] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [supervisorForm, setSupervisorForm] = useState({ full_name: '', email: '', phone: '', department_id: '', password: '' });

  const load = useCallback(async () => {
    if (!profile?.institution_id) { setQueue([]); setSupervisors([]); setStudents([]); setLoading(false); onToast('Your admin account is not linked to an institution.'); return; }
    setLoading(true);
    const projectsQuery = supabase.from('projects').select('id,title,status,student_id,profiles!projects_student_id_fkey(full_name,matric,department)').eq('institution_id', profile.institution_id).is('supervisor_id', null).in('status', ['submitted', 'supervisor_review']);
    const supervisorsQuery = supabase.from('profiles').select('id,full_name,email,phone,department,department_id,avatar_url').eq('institution_id', profile.institution_id).eq('role', 'teacher').order('full_name');
    const studentsQuery = supabase.from('profiles').select('id,full_name,email,phone,matric,department,supervisor_id,avatar_url').eq('institution_id', profile.institution_id).eq('role', 'student').order('full_name');
    const departmentsQuery = supabase.from('departments').select('id,name').eq('institution_id', profile.institution_id).order('name');
    try {
      const [projectsResult, supervisorsResult, studentsResult, departmentsResult] = await Promise.all([projectsQuery, supervisorsQuery, studentsQuery, departmentsQuery]);
      const failed = [projectsResult, supervisorsResult, studentsResult, departmentsResult].find(result => result.error);
      if (failed?.error) throw failed.error;
      setQueue((projectsResult.data || []).map(item => ({ ...item, author: item.profiles?.full_name, matric: item.profiles?.matric, dept: item.profiles?.department })));
      setSupervisors(supervisorsResult.data || []);
      setStudents(studentsResult.data || []);
      setDepartments(departmentsResult.data || []);
    } catch (error) { setQueue([]); setSupervisors([]); setStudents([]); onToast(error.message || 'Supervisor management could not be loaded.'); }
    finally { setLoading(false); }
  }, [onToast, profile]);

  useEffect(() => { load(); }, [load]);

  const createSupervisor = async event => {
    event.preventDefault();
    const department = departments.find(item => item.id === supervisorForm.department_id);
    setSaving(true);
    try {
      const data = await invoke('project-workflow', { action: 'create_supervisor', full_name: supervisorForm.full_name, email: supervisorForm.email, phone: supervisorForm.phone, password: supervisorForm.password, department: department?.name || '', department_id: supervisorForm.department_id || null });
      setSupervisors(items => [...items, data.supervisor].sort((a, b) => (a.full_name || '').localeCompare(b.full_name || '')));
      setSupervisorForm({ full_name: '', email: '', phone: '', department_id: '', password: '' });
      setCreateOpen(false);
      onToast('Supervisor account created and ready for assignment.');
    } catch (error) { onToast(error.message); }
    finally { setSaving(false); }
  };

  const assignStudent = async (studentId, supervisorId) => {
    try {
      const data = await invoke('project-workflow', { action: 'assign_student_supervisor', student_id: studentId, supervisor_id: supervisorId });
      setStudents(items => items.map(item => item.id === studentId ? { ...item, supervisor_id: supervisorId } : item));
      setQueue(items => items.filter(item => item.student_id !== studentId));
      onToast(`${data.student?.full_name || 'Student'} is now assigned to ${data.supervisor?.full_name || 'the supervisor'}.`);
    } catch (error) { onToast(error.message); }
  };

  const assignProject = async (projectId, supervisorId) => {
    try { await invoke('project-workflow', { action: 'assign_supervisor', project_id: projectId, supervisor_id: supervisorId }); setQueue(items => items.filter(item => item.id !== projectId)); onToast('Supervisor assigned and notification sent.'); }
    catch (error) { onToast(error.message); }
  };

  if (loading) return <PageSkeleton role="admin" />;
  const unassignedStudents = students.filter(student => !student.supervisor_id);
  return <section className="supervisor-management" id="admin-supervisors">
    <section className="surface"><SectionHeader eyebrow="Supervisor management" title="Supervisor directory" copy="Create supervisors, review their contact details, and keep every student connected to an academic reviewer." action={<div className="card-actions"><button className="button button-primary button-small" type="button" onClick={() => setCreateOpen(true)}><UserPlus size={15} />Add supervisor</button><button className="button button-ghost button-small" type="button" onClick={() => setAssignOpen(true)}><UserCheck size={15} />Assign students</button></div>} />
      {supervisors.length ? <div className="supervisor-directory">{supervisors.map(supervisor => <div className="supervisor-directory-card" key={supervisor.id}><div className="identity-cell"><ProfileAvatar name={supervisor.full_name} src={supervisor.avatar_url} size="avatar-medium" /><div><h3>{supervisor.full_name || 'Unnamed supervisor'}</h3><ContactDetails person={supervisor} roleLabel={`${students.filter(student => student.supervisor_id === supervisor.id).length} assigned student${students.filter(student => student.supervisor_id === supervisor.id).length === 1 ? '' : 's'}`} /></div></div><button className="button button-ghost button-small" type="button" onClick={() => setAssignOpen(true)}><UserCheck size={14} />Assign student</button></div>)}</div> : <EmptyState icon={UserPlus} title="No supervisors yet" copy="Create the first supervisor account to start routing student projects." />}
    </section>
    <section className="surface"><SectionHeader eyebrow="Coverage control" title="Student supervisor coverage" copy="Every student is shown here. Students marked as needing assignment cannot enter supervisor review until an administrator assigns a supervisor." action={<span className={unassignedStudents.length ? 'tag tag-warning' : 'tag'}>{unassignedStudents.length ? `${unassignedStudents.length} need assignment` : 'All students covered'}</span>} />{students.length ? <div className="contact-directory">{students.map(student => <StudentAssignmentRow key={student.id} student={student} supervisors={supervisors} onAssign={assignStudent} />)}</div> : <EmptyState icon={Users} title="No student profiles found" copy="Registered student accounts will appear here." />}</section>
    <section className="surface"><SectionHeader eyebrow="Workflow exceptions" title="Unassigned review queue" copy="Projects without a supervisor are held here until an administrator resolves the assignment." action={<span className="tag"><LockKeyhole size={12} />Protected action</span>} />{queue.length ? <div className="queue-list">{queue.map(item => <AssignmentRow item={item} supervisors={supervisors} onAssign={assignProject} key={item.id} />)}</div> : <EmptyState icon={UserCheck} title="Assignment queue is clear" copy="Every active project currently has a supervisor." />}</section>
    <Modal open={createOpen} onClose={() => setCreateOpen(false)} eyebrow="Supervisor management" title="Add new supervisor">
      <form className="form-grid" onSubmit={createSupervisor}><div className="field full"><label htmlFor="new-supervisor-name">Full name</label><input id="new-supervisor-name" required value={supervisorForm.full_name} onChange={event => setSupervisorForm({ ...supervisorForm, full_name: event.target.value })} placeholder="Dr. Amina Yusuf" /></div><div className="field"><label htmlFor="new-supervisor-email">Email address</label><input id="new-supervisor-email" type="email" required value={supervisorForm.email} onChange={event => setSupervisorForm({ ...supervisorForm, email: event.target.value })} placeholder="supervisor@kasu.edu.ng" /></div><div className="field"><label htmlFor="new-supervisor-phone">Phone number</label><input id="new-supervisor-phone" value={supervisorForm.phone} onChange={event => setSupervisorForm({ ...supervisorForm, phone: event.target.value })} placeholder="0803 000 0000" /></div><div className="field"><label htmlFor="new-supervisor-department">Department</label><select id="new-supervisor-department" required value={supervisorForm.department_id} onChange={event => setSupervisorForm({ ...supervisorForm, department_id: event.target.value })}><option value="">Select department</option>{departments.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></div><div className="field"><label htmlFor="new-supervisor-password">Temporary password</label><input id="new-supervisor-password" type="password" minLength="6" required value={supervisorForm.password} onChange={event => setSupervisorForm({ ...supervisorForm, password: event.target.value })} placeholder="At least 6 characters" /></div><p className="helper full">The account is confirmed immediately. Share the temporary password securely and ask the supervisor to change it after first login.</p><div className="modal-actions full"><button className="button button-ghost" type="button" onClick={() => setCreateOpen(false)}>Cancel</button><button className="button button-primary" disabled={saving}>{saving ? 'Creating...' : 'Create supervisor'}</button></div></form>
    </Modal>
    <Modal open={assignOpen} onClose={() => setAssignOpen(false)} eyebrow="Coverage control" title="Assign a student" wide><p className="helper">Choose a supervisor directly from the student coverage list below, or close this dialog and use the assignment controls beside each student.</p><div className="contact-directory" style={{ marginTop: '1rem' }}>{students.map(student => <StudentAssignmentRow key={`modal-${student.id}`} student={student} supervisors={supervisors} onAssign={(studentId, supervisorId) => { assignStudent(studentId, supervisorId); setAssignOpen(false); }} />)}</div></Modal>
  </section>;
}

function StudentAssignmentRow({ student, supervisors, onAssign }) { const [selected, setSelected] = useState(student.supervisor_id || ''); const changed = selected && selected !== student.supervisor_id; return <div className={`contact-directory-item ${student.supervisor_id ? '' : 'needs-assignment'}`}><div className="identity-cell"><ProfileAvatar name={student.full_name} src={student.avatar_url} /><div><strong>{student.full_name || 'Unnamed student'}</strong><span className="helper">{student.matric || 'Matric pending'} · {student.department || 'Department pending'}</span><span className="helper">{student.email || 'Email not provided'} · {student.phone || 'Phone not provided'}</span></div></div><div className="assignment-control"><span className={student.supervisor_id ? 'tag' : 'tag tag-warning'}>{student.supervisor_id ? 'Assigned' : 'Needs assignment'}</span><select className="glass-input" aria-label={`Supervisor for ${student.full_name || 'student'}`} value={selected} onChange={event => setSelected(event.target.value)}><option value="">Select supervisor</option>{supervisors.map(person => <option value={person.id} key={person.id}>{person.full_name} · {person.department || 'Institution-wide'}</option>)}</select><button className="button button-primary button-small" disabled={!changed} onClick={() => onAssign(student.id, selected)}><UserCheck size={14} />{student.supervisor_id ? 'Reassign' : 'Assign'}</button></div></div>; }

function AdminReports({ schedules, generatedReports, schedule, setSchedule, createSchedule, generateReport, runDue }) { return <section className="surface" id="admin-reports"><SectionHeader eyebrow="Reporting" title="Scheduled reporting controls" copy="Generate exports, maintain recurring delivery schedules, and download private report artifacts." action={<div className="card-actions"><button className="button button-primary button-small" onClick={() => generateReport('project_lifecycle')}><Download size={15} />Generate lifecycle</button><button className="button button-ghost button-small" onClick={runDue}><RefreshCw size={15} />Run due</button></div>} /><div className="workspace-grid"><form className="surface form-grid" onSubmit={createSchedule}><div className="field"><label htmlFor="report-type">Report type</label><select id="report-type" value={schedule.report_type} onChange={event => setSchedule({ ...schedule, report_type: event.target.value })}><option value="student_register">Student register</option><option value="project_lifecycle">Project lifecycle</option><option value="financial">Financial</option><option value="archive">Archive</option></select></div><div className="field"><label htmlFor="report-frequency">Frequency</label><select id="report-frequency" value={schedule.frequency} onChange={event => setSchedule({ ...schedule, frequency: event.target.value })}><option>daily</option><option>weekly</option><option>monthly</option></select></div><div className="field full"><label htmlFor="report-recipients">Email recipients</label><input id="report-recipients" value={schedule.email_recipients} onChange={event => setSchedule({ ...schedule, email_recipients: event.target.value })} placeholder="registry@kasu.edu.ng, library@kasu.edu.ng" /><span className="helper">Recipients are stored in the schedule metadata and receive private signed links when email delivery is configured.</span></div><button className="button button-primary full"><Save size={15} />Create schedule</button></form><div className="surface"><div className="surface-head"><div><h2>Generated reports</h2><p>Private CSV files expire through signed storage links.</p></div></div>{generatedReports.length ? <div className="queue-list">{generatedReports.map(item => <div className="queue-item" key={item.id}><div><strong>{item.report_type.replaceAll('_', ' ')}</strong><small>{item.row_count} rows · {displayDate(item.generated_at)}</small></div>{item.download_url ? <a className="button button-ghost button-small" href={item.download_url} target="_blank" rel="noreferrer"><Download size={14} />Download</a> : <span className="tag">Private file</span>}</div>)}</div> : <EmptyState icon={FileCheck2} title="No reports generated" copy="Run a report to create the first private artifact." />}</div></div><div className="surface" style={{ marginTop: '1rem' }}><div className="surface-head"><div><h2>Active schedules</h2><p>{schedules.length} configured schedule{schedules.length === 1 ? '' : 's'}.</p></div></div><DataTable columns={['Report', 'Frequency', 'Next run', 'Status']} rows={schedules.map(item => [item.report_type.replaceAll('_', ' '), item.frequency, displayDate(item.next_run_at), item.is_active ? 'Active' : 'Paused'])} empty="No schedules configured." /></div></section>; }

function AdminSettings({ institution, settings, onInstitutionChange, onSettingsChange, onSave, saving }) { if (!institution || !settings) return <EmptyState icon={Settings2} title="Settings unavailable" copy="The institution configuration could not be loaded for this account." />; return <section className="surface"><SectionHeader eyebrow="White-label controls" title="Institution settings" copy="Configure branding, fees, payment splits, storage limits, and tenant domains." /><form className="form-grid" onSubmit={onSave}><div className="field"><label htmlFor="institution-name">Institution name</label><input id="institution-name" name="name" value={institution.name || ''} onChange={onInstitutionChange} /></div><div className="field"><label htmlFor="institution-short-name">Short name</label><input id="institution-short-name" name="short_name" value={institution.short_name || ''} onChange={onInstitutionChange} /></div><div className="field full"><label htmlFor="institution-domains">Allowed domains</label><input id="institution-domains" name="allowed_domains" value={Array.isArray(institution.allowed_domains) ? institution.allowed_domains.join(', ') : institution.allowed_domains || ''} onChange={onInstitutionChange} /><span className="helper">Separate custom domains with commas. Tenant resolution checks this list before the default slug.</span></div><div className="field"><label htmlFor="clearance-fee">Clearance fee (kobo)</label><input id="clearance-fee" name="clearance_fee_kobo" type="number" min="0" value={settings.clearance_fee_kobo ?? 200000} onChange={onSettingsChange} /></div><div className="field"><label htmlFor="download-fee">Repository download fee (kobo)</label><input id="download-fee" name="download_fee_kobo" type="number" min="0" value={settings.download_fee_kobo ?? 50000} onChange={onSettingsChange} /></div><div className="field"><label htmlFor="institution-share">Institution share (%)</label><input id="institution-share" name="institution_share_percent" type="number" min="0" max="100" step="0.01" value={settings.institution_share_percent ?? 50} onChange={onSettingsChange} /></div><div className="field"><label htmlFor="provider-share">Provider share (%)</label><input id="provider-share" name="provider_share_percent" type="number" min="0" max="100" step="0.01" value={settings.provider_share_percent ?? 50} onChange={onSettingsChange} /></div><div className="field full settings-subsection"><div><p className="eyebrow">Paystack routing</p><p className="helper">Use a split code, or configure subaccounts for dynamic split payments. Leave these blank to keep payments in the primary account.</p></div></div><div className="field"><label htmlFor="paystack-split-code">Paystack split code</label><input id="paystack-split-code" name="paystack_split_code" value={settings.paystack_split_code || ''} onChange={onSettingsChange} placeholder="SPL_xxxxxxxxxx" autoComplete="off" /></div><div className="field"><label htmlFor="paystack-institution-subaccount">Institution subaccount</label><input id="paystack-institution-subaccount" name="paystack_institution_subaccount" value={settings.paystack_institution_subaccount || ''} onChange={onSettingsChange} placeholder="ACCT_xxxxxxxxxx" autoComplete="off" /></div><div className="field full"><label htmlFor="paystack-provider-subaccount">SPMS provider subaccount</label><input id="paystack-provider-subaccount" name="paystack_provider_subaccount" value={settings.paystack_provider_subaccount || ''} onChange={onSettingsChange} placeholder="ACCT_xxxxxxxxxx" autoComplete="off" /></div><div className="field"><label htmlFor="primary-color">Primary color</label><input id="primary-color" name="primary_color" type="color" value={institution.primary_color || '#065F46'} onChange={onInstitutionChange} /></div><div className="field"><label htmlFor="accent-color">Accent color</label><input id="accent-color" name="accent_color" type="color" value={institution.accent_color || '#F59E0B'} onChange={onInstitutionChange} /></div><div className="modal-actions full"><button className="button button-primary" disabled={saving}><Save size={15} />{saving ? 'Saving...' : 'Save settings'}</button></div></form></section>; }

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
