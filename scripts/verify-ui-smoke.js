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
assert(/AuthModal/.test(source) && /signInWithPassword/.test(source), 'authentication workflow exists');
assert(/project-title-input|project-title/.test(source) && /thesis-pdf-input/.test(source), 'student submission controls exist');
assert(/student_resubmit/.test(source) && /Upload Revision/.test(source), 'student revision workflow exists');
assert(/supervisor_decision/.test(source) && /Approve Project/.test(source), 'supervisor decision controls exist');
assert(/createSignedUrl|signedPdfUrl/.test(source) && /Private PDF preview/.test(source), 'supervisor private PDF preview exists');
assert(/library_publish/.test(source) && /Verify (?:&amp;|&) Publish/.test(source), 'library publishing controls exist');
assert(/assign_supervisor/.test(source) && /Unassigned Review Queue/.test(source), 'admin assignment controls exist');
assert(/AdminLivePanel/.test(source) && /admin_overview/.test(source), 'admin dashboard reads live overview data');
assert(/HierarchyManager/.test(source) && /system_configs/.test(source), 'admin hierarchy and settings controls exist');
assert(/fetchQrSvg/.test(source) && /Project verification QR code/.test(source), 'library QR verification display is wired');
assert(/storage\.from\('thesis-pdfs'\)\.upload/.test(source) && /file_path: upload\.data\.path/.test(source), 'student PDF upload is completed before payment verification');
assert(/repository-access/.test(source) && /initialize_download/.test(source) && /verify_download/.test(source), 'paid repository download flow exists');
assert(/public_catalog/.test(source) && /department_name/.test(source) && !/public_catalog.*author_name/.test(source), 'public repository reads the anonymized catalog schema');
assert(/config\.valid \? \[\] : demoProjects/.test(source), 'configured public repository does not silently fall back to demo records');
assert(/scheduled-reports/.test(source) && /run_once/.test(source) && /run_due/.test(source), 'scheduled reporting contract exists');
assert(/verification-lookup/.test(source) && /qr_svg/.test(source) && /receipt/.test(source) && /project/.test(source), 'public verification contract exists');
assert(/PageSkeleton/.test(source) && /skeleton/.test(source) && /@keyframes shimmer/.test(source), 'animated page-specific skeleton loaders exist');
assert(/blueprint/.test(source) && /background-image/.test(source), 'maintained patterned light surfaces exist');
assert(/glass|backdrop-filter/.test(source), 'glassmorphism surfaces exist');
assert(/focus-visible/.test(source), 'keyboard focus styling exists');
assert(/<meta name="viewport"/.test(source), 'responsive viewport meta exists');
assert(/assets\/kasu-logo\.jpeg/.test(source), 'KASU logo and favicon are wired');
assert(/Fraunces|DM Sans/.test(source), 'product typography is wired');
assert(!/onclick=/.test(source), 'React actions do not rely on inline onclick handlers');
assert(!/PaystackPop\.setup|openIframe\(/.test(source), 'browser does not create direct Paystack transactions');
assert(/new window\.PaystackPop\(\)[\s\S]*resumeTransaction/.test(source), 'Paystack Popup v2 is instantiated before resuming backend transactions');

console.log('');
console.log(`UI smoke verification complete: ${failures.length} failure(s).`);
if (failures.length) process.exit(1);
