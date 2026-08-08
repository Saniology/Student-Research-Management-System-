export const demoProjects = [
  { id: 'demo-1', title: 'Web-Based E-Voting System', author: 'Musa Abdullahi', matric: 'KASU/SCI/20/123', dept: 'Computer Science', degree: 'BSc', abstract: 'Explores a secure web-based voting system designed to improve transparency, accessibility, and auditability in university elections.', status: 'published' },
  { id: 'demo-2', title: 'Impact of Inflation on Manufacturing', author: 'Aisha Bello', matric: 'KASU/PG/21/045', dept: 'Economics', degree: 'MSc', abstract: 'An empirical analysis of inflationary trends and their effect on manufacturing costs and firm performance in Nigeria.', status: 'published' },
  { id: 'demo-3', title: 'Climate Change Adaptation in Northern Nigeria', author: 'Ibrahim Yusuf', matric: 'KASU/PG/19/005', dept: 'Geography', degree: 'PhD', abstract: 'This thesis investigates agricultural resilience strategies used by rural communities to respond to climate change in Northern Nigeria.', status: 'published' },
  { id: 'demo-4', title: 'Antimicrobial Resistance of Bacterial Isolates', author: 'John Paul', matric: 'KASU/SCI/20/088', dept: 'Microbiology', degree: 'BSc', abstract: 'A study of bacterial isolates from water sources in Kaduna metropolis and their resistance to commonly used antibiotics.', status: 'published' },
  { id: 'demo-5', title: 'Role of Social Media in Political Campaigns', author: 'Fatima Sani', matric: 'KASU/SCI/20/012', dept: 'Mass Communication', degree: 'BSc', abstract: 'Examines how digital platforms shape voter behaviour and political participation among young people in Kaduna State.', status: 'published' },
  { id: 'demo-6', title: 'Integration of Smart Home Technology', author: 'David Okon', matric: 'KASU/ENV/20/034', dept: 'Architecture', degree: 'BSc', abstract: 'Explores sustainable residential design principles that integrate connected devices for energy efficiency and security.', status: 'published' },
];

export const demoReviewProjects = demoProjects.map((project, index) => ({
  ...project,
  status: index % 3 === 0 ? 'supervisor_review' : index % 3 === 1 ? 'revision_requested' : 'supervisor_approved',
  isDemo: true,
  revision_note: index % 3 === 1 ? 'Please clarify the methodology section, upload the corrected PDF, and resubmit without paying the clearance fee again.' : '',
}));

export const demoStats = { students: '18,425', submitted: '4,021', approved: '3,812', departments: '76' };
