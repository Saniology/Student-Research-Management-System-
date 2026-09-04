import React from 'react';

export const projectStatuses = ['draft', 'submitted', 'supervisor_review', 'revision_requested', 'supervisor_approved', 'library_review', 'published', 'cleared', 'rejected'];
const labels = { draft: 'Draft', submitted: 'Submitted', supervisor_review: 'Supervisor review', revision_requested: 'Revision requested - no second payment', supervisor_approved: 'Supervisor approved', library_review: 'Library review', published: 'Published', cleared: 'Cleared', rejected: 'Rejected' };
export function StatusChip({ status }) { return <span className={`status-chip status-${status || 'neutral'}`}><span className="status-dot" />{labels[status] || status || 'Pending'}</span>; }
