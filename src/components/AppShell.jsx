import React from 'react';
import { Bell, LogIn, LogOut, Search, ShieldCheck } from 'lucide-react';
import { fallbackTenant } from '../lib/supabase';

export function AppShell({ tenant = fallbackTenant, role, onHome, onLogin, onLogout, children, notificationCount = 0, onNotifications }) {
  return <><header className="topbar">
    <button className="brand" onClick={onHome} aria-label="Go to home"><img src={tenant.logo_url || fallbackTenant.logo_url} alt="Kaduna State University logo" /><span><strong>{tenant.short_name || 'KASU'} SPMS</strong><small>Student Project Management System</small></span></button>
    <nav className="topnav"><button onClick={onHome}>Home</button>{role ? <span className="nav-role">{role === 'teacher' ? 'Supervisor' : role} workspace</span> : <button onClick={onHome}>Repository</button>}</nav>
    <div className="top-actions">{role ? <><button className="icon-button" onClick={onNotifications} aria-label="Notifications"><Bell size={17} />{notificationCount > 0 && <span className="notification-count">{notificationCount}</span>}</button><button className="button button-danger button-small" onClick={onLogout}><LogOut size={15} />Logout</button></> : <button className="button button-primary button-small" onClick={onLogin}><LogIn size={15} />Login</button>}</div>
  </header><main>{children}</main></>;
}

export function SectionHeader({ eyebrow, title, copy, action }) { return <div className="section-header"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2>{copy && <p className="muted section-copy">{copy}</p>}</div>{action}</div>; }
export function EmptyState({ icon: Icon = ShieldCheck, title, copy, action }) { return <div className="empty-state"><span className="empty-icon"><Icon size={22} /></span><h3>{title}</h3><p>{copy}</p>{action}</div>; }
export function SearchBox({ value, onChange, placeholder = 'Search projects, departments, or authors' }) { return <label className="search-box"><Search size={17} /><input value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} aria-label={placeholder} /></label>; }
