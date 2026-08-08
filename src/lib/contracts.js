import { config, invoke } from './supabase';

export const workflowActions = {
  supervisorDecision: 'supervisor_decision',
  studentResubmit: 'student_resubmit',
  assignSupervisor: 'assign_supervisor',
  libraryPublish: 'library_publish',
  issueReceipt: 'issue_receipt',
  repositoryGetUrl: 'get_download_url',
  repositoryInitialize: 'initialize_download',
  repositoryVerify: 'verify_download',
  reportsDue: 'run_due',
  reportsOnce: 'run_once',
};
export const verificationTypes = ['qr_svg', 'receipt', 'project'];
export const projectStatuses = ['draft', 'submitted', 'supervisor_review', 'revision_requested', 'supervisor_approved', 'library_review', 'published', 'cleared', 'rejected'];

export async function issueReceipt(projectId) {
  return invoke('project-workflow', { action: workflowActions.issueReceipt, project_id: projectId });
}

export async function retryPaymentVerification(reference, metadata = {}) {
  if (!reference) throw new Error('A payment reference is required to retry verification.');
  return invoke('verify-paystack', { reference, ...metadata });
}

export async function runScheduledReport(reportType, emailRecipients = []) {
  return invoke('scheduled-reports', { action: workflowActions.reportsOnce, report_type: reportType, email_recipients: emailRecipients });
}

export async function runDueReports() {
  return invoke('scheduled-reports', { action: workflowActions.reportsDue });
}

export async function lookupVerification(type, payload) {
  if (!config.valid) throw new Error('Supabase is not configured.');
  if (!verificationTypes.includes(type)) throw new Error('Unsupported verification type.');
  const response = await fetch(`${config.url}/functions/v1/verification-lookup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: config.anonKey },
    body: JSON.stringify({ type, ...payload }),
  });
  const data = await response.json();
  if (!response.ok || data?.error) throw new Error(data?.error || 'Verification failed');
  return data;
}
