import { Archetype, PrismaClient, Role, UserStatus } from '@prisma/client';
import { createHash } from 'node:crypto';
import { catalogPresetsForCode } from '@vonos/types';

/** Dev-only password hasher; runtime auth upgrades to bcrypt on login. */
export function devPasswordHash(password: string): string {
  return `dev:${createHash('sha256').update(password).digest('hex')}`;
}

function withCatalog<T extends { code?: string }>(config: T) {
  return { ...config, ...catalogPresetsForCode(config.code) };
}

const stockNavItems = (code: string) => [
  { label: 'Overview', icon: 'layout-dashboard', route: `/${code}/overview`, pageType: 'dashboard' },
  { label: 'Finance', icon: 'wallet', route: `/${code}/finance`, pageType: 'dashboard' },
  { label: 'Users', icon: 'users', route: `/${code}/users`, pageType: 'form' },
  { label: 'Settings', icon: 'settings', route: `/${code}/settings`, pageType: 'form' },
];

const warehouseConfig = {
  tenantId: 'tenant_vw_001',
  code: 'VW',
  name: 'Vonos Warehouse',
  archetype: 'stock',
  navItems: stockNavItems('VW'),
  kpiCards: [
    { label: 'Total SKU', icon: 'package', metricKey: 'totalSku', color: '#059669' },
    { label: 'Today Inbound', icon: 'arrow-down', metricKey: 'todayInbound', color: '#2563eb' },
    { label: 'Today Outbound', icon: 'arrow-up', metricKey: 'todayOutbound', color: '#9333ea' },
    { label: 'Stock Values', icon: 'calculator', metricKey: 'stockValue', color: '#e11d48' },
  ],
  terminology: { item: 'SKU', inventory: 'Inventory', supplier: 'Supplier' },
  enabledModules: ['inventory', 'movements', 'suppliers', 'purchases', 'paymentAccounts', 'reports', 'finance'],
};

const kidsWearConfig = {
  tenantId: 'tenant_vkw_001',
  code: 'VKW',
  name: 'Vonos Kids Wear',
  archetype: 'stock',
  navItems: stockNavItems('VKW'),
  kpiCards: [
    { label: 'Total SKU', icon: 'package', metricKey: 'totalSku', color: '#059669' },
    { label: "Today's Sales", icon: 'shopping-bag', metricKey: 'todaySales', color: '#2563eb' },
    { label: 'Returns', icon: 'rotate-ccw', metricKey: 'returns', color: '#9333ea' },
    { label: 'Stock Value', icon: 'calculator', metricKey: 'stockValue', color: '#e11d48' },
  ],
  terminology: { item: 'Variant', inventory: 'Inventory', supplier: 'Supplier', collection: 'Collection' },
  enabledModules: ['inventory', 'movements', 'suppliers', 'purchases', 'paymentAccounts', 'reports', 'finance', 'variants'],
};

const transactionNavItems = (code: string) => [
  { label: 'Overview', icon: 'layout-dashboard', route: `/${code}/overview`, pageType: 'dashboard' },
  { label: 'Customers', icon: 'users', route: `/${code}/customers`, pageType: 'list' },
  { label: 'Finance', icon: 'wallet', route: `/${code}/finance`, pageType: 'dashboard' },
  { label: 'Users', icon: 'users', route: `/${code}/users`, pageType: 'form' },
  { label: 'Settings', icon: 'settings', route: `/${code}/settings`, pageType: 'form' },
];

const vispConfig = {
  tenantId: 'tenant_visp_001',
  code: 'VISP',
  name: 'Vonos Institute Spare Parts',
  archetype: 'transaction',
  navItems: transactionNavItems('VISP'),
  kpiCards: [
    { label: "Today's Sales", icon: 'receipt', metricKey: 'todaySales', color: '#059669' },
    { label: 'Returns', icon: 'rotate-ccw', metricKey: 'returns', color: '#2563eb' },
    { label: 'Low Stock', icon: 'alert-triangle', metricKey: 'lowStock', color: '#9333ea' },
    { label: 'Revenue', icon: 'wallet', metricKey: 'revenue', color: '#e11d48' },
  ],
  terminology: { sale: 'Sale', customer: 'Customer', return: 'Return' },
  enabledModules: ['sales', 'returns', 'customers', 'inventory', 'paymentAccounts', 'pos', 'quotations', 'reports', 'finance'],
};

const vspConfig = {
  tenantId: 'tenant_vsp_001',
  code: 'VSP',
  name: 'Vonos SP Marketplace',
  archetype: 'transaction',
  navItems: transactionNavItems('VSP'),
  kpiCards: [
    { label: "Today's Orders", icon: 'receipt', metricKey: 'todaySales', color: '#059669' },
    { label: 'Listings', icon: 'package', metricKey: 'totalSku', color: '#2563eb' },
    { label: 'Low Stock', icon: 'alert-triangle', metricKey: 'lowStock', color: '#9333ea' },
    { label: 'Revenue', icon: 'wallet', metricKey: 'revenue', color: '#e11d48' },
  ],
  terminology: { sale: 'Order', customer: 'Buyer', return: 'Return' },
  enabledModules: ['sales', 'returns', 'customers', 'inventory', 'paymentAccounts', 'pos', 'quotations', 'reports', 'finance'],
};

const cafeConfig = {
  tenantId: 'tenant_vc_001',
  code: 'VC',
  name: 'Vonos Cafe',
  archetype: 'transaction',
  navItems: [
    { label: 'Overview', icon: 'layout-dashboard', route: '/VC/overview', pageType: 'dashboard' },
    { label: 'Tables', icon: 'grid-3x3', route: '/VC/tables', pageType: 'list' },
    { label: 'Suppliers', icon: 'truck', route: '/VC/suppliers', pageType: 'list' },
    { label: 'Finance', icon: 'wallet', route: '/VC/finance', pageType: 'dashboard' },
    { label: 'Users', icon: 'users', route: '/VC/users', pageType: 'form' },
    { label: 'Settings', icon: 'settings', route: '/VC/settings', pageType: 'form' },
  ],
  kpiCards: [
    { label: "Today's Orders", icon: 'receipt', metricKey: 'todayOrders', color: '#059669' },
    { label: 'Active Tables', icon: 'grid-3x3', metricKey: 'activeTables', color: '#2563eb' },
    { label: 'Low Stock', icon: 'alert-triangle', metricKey: 'lowStock', color: '#9333ea' },
    { label: 'Revenue', icon: 'wallet', metricKey: 'revenue', color: '#e11d48' },
  ],
  terminology: { order: 'Order', menuItem: 'Menu Item', table: 'Table' },
  enabledModules: ['orders', 'tables', 'inventory', 'paymentAccounts', 'pos', 'quotations', 'reports', 'finance'],
};

const mechanicsConfig = {
  tenantId: 'tenant_vm_001',
  code: 'VM',
  name: 'Vonos Mechanics',
  archetype: 'job',
  navItems: [
    { label: 'Overview', icon: 'layout-dashboard', route: '/VM/overview', pageType: 'dashboard' },
    { label: 'Jobs', icon: 'wrench', route: '/VM/jobs', pageType: 'list' },
    { label: 'Vehicles', icon: 'car', route: '/VM/vehicles', pageType: 'list' },
    { label: 'Requisitions', icon: 'clipboard-list', route: '/VM/requisitions', pageType: 'list' },
    { label: 'Customers', icon: 'users', route: '/VM/customers', pageType: 'list' },
    { label: 'Reports', icon: 'pie-chart', route: '/VM/reports', pageType: 'dashboard' },
    { label: 'Finance', icon: 'wallet', route: '/VM/finance', pageType: 'dashboard' },
    { label: 'Users', icon: 'users', route: '/VM/users', pageType: 'form' },
    { label: 'Settings', icon: 'settings', route: '/VM/settings', pageType: 'form' },
  ],
  kpiCards: [
    { label: 'Open Jobs', icon: 'wrench', metricKey: 'openJobs', color: '#059669' },
    { label: 'In Shop', icon: 'car', metricKey: 'inShop', color: '#2563eb' },
    { label: 'Parts Pending', icon: 'package', metricKey: 'partsPending', color: '#9333ea' },
    { label: 'Revenue', icon: 'wallet', metricKey: 'revenue', color: '#e11d48' },
  ],
  terminology: {
    job: 'Job',
    vehicle: 'Vehicle',
    customer: 'Customer',
    requisition: 'Parts Requisition',
  },
  enabledModules: ['jobs', 'vehicles', 'requisitions', 'customers', 'reports', 'finance'],
};

const mechShopConfig = {
  tenantId: 'tenant_vms_001',
  code: 'VMS',
  name: 'Vonos Mech Shop',
  archetype: 'job',
  navItems: [
    { label: 'Overview', icon: 'layout-dashboard', route: '/VMS/overview', pageType: 'dashboard' },
    { label: 'Jobs', icon: 'wrench', route: '/VMS/jobs', pageType: 'list' },
    { label: 'Requisitions', icon: 'clipboard-list', route: '/VMS/requisitions', pageType: 'list' },
    { label: 'Customers', icon: 'users', route: '/VMS/customers', pageType: 'list' },
    { label: 'Reports', icon: 'pie-chart', route: '/VMS/reports', pageType: 'dashboard' },
    { label: 'Finance', icon: 'wallet', route: '/VMS/finance', pageType: 'dashboard' },
    { label: 'Users', icon: 'users', route: '/VMS/users', pageType: 'form' },
    { label: 'Settings', icon: 'settings', route: '/VMS/settings', pageType: 'form' },
  ],
  kpiCards: [
    { label: 'Active Jobs', icon: 'wrench', metricKey: 'activeJobs', color: '#059669' },
    { label: 'Completed', icon: 'check-circle', metricKey: 'completedJobs', color: '#2563eb' },
    { label: 'Pending QC', icon: 'shield-check', metricKey: 'pendingQc', color: '#9333ea' },
    { label: 'Revenue', icon: 'wallet', metricKey: 'revenue', color: '#e11d48' },
  ],
  terminology: {
    job: 'Job',
    customer: 'Customer',
    requisition: 'Material Requisition',
  },
  enabledModules: ['jobs', 'requisitions', 'customers', 'reports', 'finance'],
};

/** @deprecated Use mechanicsConfig */
export { mechanicsConfig as automotiveConfig };

const saloonConfig = {
  tenantId: 'tenant_vs_001',
  code: 'VS',
  name: 'Vonos Saloon',
  archetype: 'appointment',
  navItems: [
    { label: 'Overview', icon: 'layout-dashboard', route: '/VS/overview', pageType: 'dashboard' },
    { label: 'Appointments', icon: 'calendar', route: '/VS/appointments', pageType: 'list' },
    { label: 'Customers', icon: 'users', route: '/VS/customers', pageType: 'list' },
    { label: 'Services', icon: 'scissors', route: '/VS/services', pageType: 'list' },
    { label: 'Stylist Schedule', icon: 'clock', route: '/VS/stylist-schedule', pageType: 'form' },
    { label: 'Reports', icon: 'pie-chart', route: '/VS/reports', pageType: 'dashboard' },
    { label: 'Finance', icon: 'wallet', route: '/VS/finance', pageType: 'dashboard' },
    { label: 'Users', icon: 'users', route: '/VS/users', pageType: 'form' },
    { label: 'Settings', icon: 'settings', route: '/VS/settings', pageType: 'form' },
  ],
  kpiCards: [
    { label: "Today's Appts", icon: 'calendar', metricKey: 'todayAppts', color: '#059669' },
    { label: 'Available Slots', icon: 'clock', metricKey: 'available', color: '#2563eb' },
    { label: 'No-shows', icon: 'user-x', metricKey: 'noShows', color: '#9333ea' },
    { label: 'Revenue', icon: 'wallet', metricKey: 'revenue', color: '#e11d48' },
  ],
  terminology: { appointment: 'Appointment', customer: 'Customer', service: 'Service', stylist: 'Stylist' },
  enabledModules: ['appointments', 'services', 'reports', 'finance'],
};

const tenants: Array<{
  id: string;
  code: string;
  name: string;
  archetype: Archetype;
  config: object;
}> = [
  { id: 'tenant_vw_001', code: 'VW', name: 'Vonos Warehouse', archetype: 'stock', config: withCatalog(warehouseConfig) },
  { id: 'tenant_vkw_001', code: 'VKW', name: 'Vonos Kids Wear', archetype: 'stock', config: withCatalog(kidsWearConfig) },
  { id: 'tenant_visp_001', code: 'VISP', name: 'Vonos Institute Spare Parts', archetype: 'transaction', config: withCatalog(vispConfig) },
  { id: 'tenant_vsp_001', code: 'VSP', name: 'Vonos SP Marketplace', archetype: 'transaction', config: withCatalog(vspConfig) },
  { id: 'tenant_vc_001', code: 'VC', name: 'Vonos Cafe', archetype: 'transaction', config: withCatalog(cafeConfig) },
  { id: 'tenant_vm_001', code: 'VM', name: 'Vonos Mechanics', archetype: 'job', config: withCatalog(mechanicsConfig) },
  { id: 'tenant_vms_001', code: 'VMS', name: 'Vonos Mech Shop', archetype: 'job', config: withCatalog(mechShopConfig) },
  { id: 'tenant_vs_001', code: 'VS', name: 'Vonos Saloon', archetype: 'appointment', config: withCatalog(saloonConfig) },
  {
    id: 'tenant_vag_001',
    code: 'VAG',
    name: 'Vonos Autos Group',
    archetype: 'stock',
    config: withCatalog({ ...warehouseConfig, tenantId: null, code: 'VAG', name: 'Vonos Autos Group' }),
  },
];

export async function seedTenantsAndUsers(prisma: PrismaClient): Promise<void> {
  for (const tenant of tenants) {
    await prisma.tenant.upsert({
      where: { code: tenant.code },
      create: tenant,
      update: {
        name: tenant.name,
        archetype: tenant.archetype,
        config: tenant.config,
      },
    });
    console.log(`Tenant ${tenant.code} (${tenant.id})`);
  }

  await prisma.user.upsert({
    where: { email: 'admin@vonos.test' },
    create: {
      id: 'user_admin_001',
      email: 'admin@vonos.test',
      passwordHash: devPasswordHash('password'),
      name: 'Warehouse Admin',
      role: Role.admin,
      status: UserStatus.active,
      tenantId: 'tenant_vw_001',
    },
    update: {
      name: 'Warehouse Admin',
      role: Role.admin,
      status: UserStatus.active,
      tenantId: 'tenant_vw_001',
    },
  });
  console.log('User admin@vonos.test');

  await prisma.user.upsert({
    where: { email: 'admin@vag.vonos' },
    create: {
      id: 'user_vag_admin',
      email: 'admin@vag.vonos',
      passwordHash: devPasswordHash('demo123'),
      name: 'VAG Super Admin',
      role: Role.super_admin,
      status: UserStatus.active,
      tenantId: null,
    },
    update: {
      name: 'VAG Super Admin',
      role: Role.super_admin,
      status: UserStatus.active,
      tenantId: null,
    },
  });
  console.log('User admin@vag.vonos (super_admin)');

  const tenantAdmins = [
    { id: 'user_visp_admin', email: 'admin@visp.vonos', tenantId: 'tenant_visp_001', name: 'VISP Admin' },
    { id: 'user_vsp_admin', email: 'admin@vsp.vonos', tenantId: 'tenant_vsp_001', name: 'VSP Admin' },
    { id: 'user_vc_admin', email: 'admin@vc.vonos', tenantId: 'tenant_vc_001', name: 'Cafe Admin' },
    { id: 'user_vm_admin', email: 'admin@vm.vonos', tenantId: 'tenant_vm_001', name: 'Mechanics Admin' },
    { id: 'user_vms_admin', email: 'admin@vms.vonos', tenantId: 'tenant_vms_001', name: 'Mech Shop Admin' },
    { id: 'user_vs_admin', email: 'admin@vs.vonos', tenantId: 'tenant_vs_001', name: 'Saloon Admin' },
  ];

  for (const admin of tenantAdmins) {
    await prisma.user.upsert({
      where: { email: admin.email },
      create: {
        id: admin.id,
        email: admin.email,
        passwordHash: devPasswordHash('password'),
        name: admin.name,
        role: Role.admin,
        status: UserStatus.active,
        tenantId: admin.tenantId,
      },
      update: {
        name: admin.name,
        role: Role.admin,
        status: UserStatus.active,
        tenantId: admin.tenantId,
      },
    });
    console.log(`User ${admin.email} (${admin.tenantId})`);
  }

  const inviteUserId = 'user_vw_manager_invite';
  const inviteRaw = 'invite-vw-manager';
  const inviteHash = createHash('sha256').update(inviteRaw).digest('hex');
  const invitePlaceholderHash = devPasswordHash('invite-placeholder-not-for-login');

  await prisma.user.upsert({
    where: { email: 'manager@warehouse.vonos' },
    create: {
      id: inviteUserId,
      email: 'manager@warehouse.vonos',
      passwordHash: invitePlaceholderHash,
      name: 'New Manager',
      role: Role.manager,
      status: UserStatus.invited,
      tenantId: 'tenant_vw_001',
    },
    update: {
      name: 'New Manager',
      role: Role.manager,
      status: UserStatus.invited,
      tenantId: 'tenant_vw_001',
    },
  });

  await prisma.authToken.deleteMany({
    where: { userId: inviteUserId, type: 'invite', usedAt: null },
  });
  await prisma.authToken.create({
    data: {
      userId: inviteUserId,
      type: 'invite',
      tokenHash: inviteHash,
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    },
  });
  console.log('Invite manager@warehouse.vonos → /invite/invite-vw-manager');
}
