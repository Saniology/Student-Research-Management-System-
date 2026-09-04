#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const files = ['index.html', 'src/App.jsx', 'src/styles.css', 'src/components/AppShell.jsx', 'src/components/Skeleton.jsx', 'src/components/Modal.jsx', 'src/components/StatusChip.jsx', 'src/lib/supabase.js', 'src/lib/contracts.js'];
const source = files.map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
const failures = [];

function pass(message) { console.log(`PASS   ${message}`); }
function fail(message) { failures.push(message); console.log(`FAIL   ${message}`); }
function assert(condition, message) { condition ? pass(message) : fail(message); }

assert(/id="root"/.test(source) && /src\/main\.jsx/.test(source), 'React application root exists');
assert(/StudentWorkspace/.test(source), 'student role workspace exists');
assert(/TeacherWorkspace/.test(source), 'supervisor role workspace exists');
assert(/LibraryWorkspace/.test(source), 'library role workspace exists');
assert(/AdminWorkspace/.test(source), 'admin role workspace exists');
assert(/workspaceSectionTarget/.test(source) && /scrollToWorkspaceSection/.test(source) && /aria-current=\{active \? 'page' : undefined\}/.test(source), 'workspace sidebars have functional navigation and active state');
assert(/Notification center/.test(source) && /Mark all as read/.test(source) && /onNotifications=\{openNotificationCenter\}/.test(source), 'notification center opens from the authenticated shell');
assert(/AuthModal/.test(source) && /signInWithPassword/.test(source), 'authentication workflow exists');
assert(/project-title-input|project-title/.test(source) && /thesis-pdf-input/.test(source), 'student submission controls exist');
assert(/student-overview/.test(source) && /student-submission/.test(source) && /student-payments/.test(source) && /student-receipt/.test(source) && /student-profile/.test(source), 'student dashboard has separate sidebar pages');
assert(/student_resubmit/.test(source) && /Upload Revision/.test(source), 'student revision workflow exists');
assert(/supervisor_decision/.test(source) && /Approve Project/.test(source), 'supervisor decision controls exist');
assert(/createSignedUrl|signedPdfUrl/.test(source) && /Private PDF preview/.test(source), 'supervisor private PDF preview exists');
assert(/Assigned projects/.test(source) && /Assigned students/.test(source) && /Review history/.test(source) && /Supervisor profile/.test(source), 'supervisor dashboard has separate sidebar pages');
assert(/library_verify/.test(source) && /library_publish/.test(source) && /Verify metadata/.test(source), 'library metadata verification and publishing controls exist');
assert(/library-queue/.test(source) && /library-catalogue/.test(source) && /library-qr/.test(source) && /library-archive/.test(source), 'library desk has separate sidebar pages');
assert(/assign_supervisor/.test(source) && /Unassigned Review Queue/.test(source), 'admin assignment controls exist');
assert(/Supervisor directory/.test(source) && /Student coverage/.test(source) && /Assignment queue/.test(source), 'admin supervisor workflows have separate sidebar pages');
assert(/AdminLivePanel/.test(source) && /admin_overview/.test(source), 'admin dashboard reads live overview data');
assert(/clearance_receipts[\s\S]*profiles!clearance_receipts_student_id_fkey\(full_name,matric\)/.test(source), 'admin receipt evidence includes the student identity');
assert(/profiles!payments_student_id_fkey!inner\(institution_id\)/.test(source) && /eq\(['"]profiles\.institution_id['"]/.test(source), 'admin payment evidence is explicitly tenant scoped');
assert(/failedQuery[\s\S]*result\?\.error/.test(source), 'admin data loader surfaces failed queries');
assert(/HierarchyManager/.test(source) && /system_configs/.test(source), 'admin hierarchy and settings controls exist');
assert(/courses/.test(source) && /new-course/.test(source), 'admin course management controls exist');
assert(/paystack_split_code/.test(source) && /paystack_institution_subaccount/.test(source) && /paystack_provider_subaccount/.test(source), 'admin Paystack split routing controls exist');
assert(/fetchQrSvg/.test(source) && /Project verification QR code/.test(source), 'library QR verification display is wired');
assert(/storage\.from\('thesis-pdfs'\)\.upload/.test(source) && /file_path: upload\.data\.path/.test(source), 'student PDF upload is completed before payment verification');
assert(/repository-access/.test(source) && /initialize_download/.test(source) && /verify_download/.test(source), 'paid repository download flow exists');
assert(/GuestDownloadModal/.test(source) && /Account required/.test(source) && /Create account/.test(source), 'public repository requires an authenticated student account before payment');
assert(/receiptQrCommands/.test(source) && /qrcode-generator/.test(source), 'receipt PDF embeds a QR verification graphic');
assert(/departmentScope/.test(source) && /department_name/.test(source), 'student repository browsing is department scoped');
assert(/queueQuery/.test(source) && /queueStatus/.test(source), 'library queue has search and status filters');
assert(/ProfileAvatar/.test(source) && /avatar_url/.test(source), 'staff review surfaces show student identity context');
assert(/project\.project_id \? \{ \.\.\.project, id: project\.project_id \}/.test(source), 'public repository downloads use the underlying project identifier');
assert(/public_catalog/.test(source) && /department_name/.test(source) && !/public_catalog.*author_name/.test(source), 'public repository reads the anonymized catalog schema');
assert(/catalogQuery\.or\(/.test(source) && /title\.ilike|department_name\.ilike|course_name\.ilike/.test(source), 'public repository searches catalog fields server-side');
assert(/localPreview \|\| !config\.valid \? demoProjects : \[\]/.test(source), 'configured public repository does not silently fall back to demo records');
assert(/scheduled-reports/.test(source) && /run_once/.test(source) && /run_due/.test(source), 'scheduled reporting contract exists');
assert(/verification-lookup/.test(source) && /qr_svg/.test(source) && /receipt/.test(source) && /project/.test(source), 'public verification contract exists');
assert(/PageSkeleton/.test(source) && /skeleton/.test(source) && /@keyframes shimmer/.test(source), 'animated page-specific skeleton loaders exist');
assert(/RepositorySkeleton/.test(source) && /catalogLoading/.test(source), 'public repository uses a shaped loading skeleton before empty states');
assert(/blueprint/.test(source) && /background-image/.test(source), 'maintained patterned light surfaces exist');
assert(/glass|backdrop-filter/.test(source), 'glassmorphism surfaces exist');
assert(/focus-visible/.test(source), 'keyboard focus styling exists');
assert(/<meta name="viewport"/.test(source), 'responsive viewport meta exists');
assert(/assets\/kasu-logo\.jpeg/.test(source), 'KASU logo and favicon are wired');
assert(/Fraunces|DM Sans/.test(source), 'product typography is wired');
assert(!/onclick=/.test(source), 'React actions do not rely on inline onclick handlers');
assert(!/PaystackPop\.setup|openIframe\(/.test(source), 'browser does not create direct Paystack transactions');
assert(/new window\.PaystackPop\(\)[\s\S]*resumeTransaction/.test(source), 'Paystack Popup v2 is instantiated before resuming backend transactions');
assert(/Math\.max\(1,[\s\S]*numericValue/.test(source), 'analytics progress bars remain valid for zero-record institutions');
assert(/eq\(['\"]transaction_type['\"]\s*,\s*['\"]clearance_fee['\"]\)/.test(source), 'student payment evidence is scoped to clearance fees');
assert(/clearance_receipts['\"]\)\.select\(['\"]\*['\"]\)/.test(source), 'student workspace restores issued receipts after reload');
assert(/\[\s*['"]published['"]\s*,\s*['"]cleared['"]\s*\]\.includes\(project\?\.status\)/.test(source), 'students can issue receipts after library publication');
assert(/downloadReceiptPdf/.test(source) && /Download receipt PDF/.test(source), 'students can download issued clearance receipts');
assert(/pendingVerification/.test(source) && /Retry verification/.test(source) && /localStorage/.test(source), 'students can retry failed payment verification without a second charge');

console.log('');
console.log(`UI smoke verification complete: ${failures.length} failure(s).`);
if (failures.length) process.exit(1);
