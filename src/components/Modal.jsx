import React, { useEffect } from 'react';
import { ShieldCheck, X } from 'lucide-react';

export function Modal({ open, onClose, title, eyebrow, children, wide = false, id, variant = 'default' }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = event => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);
  if (!open) return null;
  return <div className="modal-backdrop" role="dialog" aria-modal="true" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <div className={`modal-shell ${wide ? 'modal-wide' : ''} ${variant === 'auth' ? 'auth-modal-shell' : ''}`} id={id}>
      <div className={`modal-header ${variant === 'auth' ? 'auth-modal-header' : ''}`}>
        {variant === 'auth' ? <div className="auth-modal-heading"><span className="auth-modal-mark"><ShieldCheck size={18} /></span><div><p className="auth-modal-eyebrow">{eyebrow}</p><h2>{title}</h2></div></div> : <div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div>}
        <button className={variant === 'auth' ? 'auth-modal-close' : 'icon-button'} onClick={onClose} aria-label="Close dialog"><X size={18} /></button>
      </div>
      <div className={variant === 'auth' ? 'auth-modal-body' : ''}>{children}</div>
    </div>
  </div>;
}
