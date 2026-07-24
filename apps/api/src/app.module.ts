import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './common/prisma/prisma.module';
import { CacheModule } from './common/cache/cache.module';
import { HealthController } from './health/health.controller';
import { AuthModule } from './modules/auth/auth.module';
import { CustomersModule } from './modules/customers/customers.module';
import { ItemsModule } from './modules/items/items.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ReportsModule } from './modules/reports/reports.module';
import { OverviewModule } from './modules/overview/overview.module';
import { SalesModule } from './modules/sales/sales.module';
import { StockMovementsModule } from './modules/stock-movements/stock-movements.module';
import { SuppliersModule } from './modules/suppliers/suppliers.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { UsersModule } from './modules/users/users.module';
import { AuditModule } from './modules/audit/audit.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { AppointmentsModule } from './modules/appointments/appointments.module';
import { VehiclesModule } from './modules/vehicles/vehicles.module';
import { RequisitionsModule } from './modules/requisitions/requisitions.module';
import { SalonServicesModule } from './modules/salon-services/salon-services.module';
import { CafeTablesModule } from './modules/cafe-tables/cafe-tables.module';
import { PaymentAccountsModule } from './modules/payment-accounts/payment-accounts.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { CatalogMetaModule } from './modules/catalog-meta/catalog-meta.module';
import { ExpensesModule } from './modules/expenses/expenses.module';
import { CustomerGroupsModule } from './modules/customer-groups/customer-groups.module';
import { HrmModule } from './modules/hrm/hrm.module';
import { InvoiceSettingsModule } from './modules/invoice-settings/invoice-settings.module';
import { DiscountsModule } from './modules/discounts/discounts.module';
import { VariationsModule } from './modules/variations/variations.module';
import { InvoicesModule } from './modules/invoices/invoices.module';

@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60_000,
        limit: 120,
      },
    ]),
    PrismaModule,
    CacheModule,
    AuthModule,
    AuditModule,
    TenantsModule,
    ItemsModule,
    CatalogModule,
    StockMovementsModule,
    SuppliersModule,
    LedgerModule,
    ReportsModule,
    OverviewModule,
    SalesModule,
    JobsModule,
    CustomersModule,
    NotificationsModule,
    UsersModule,
    AppointmentsModule,
    VehiclesModule,
    RequisitionsModule,
    SalonServicesModule,
    CafeTablesModule,
    PaymentAccountsModule,
    PaymentsModule,
    CatalogMetaModule,
    ExpensesModule,
    CustomerGroupsModule,
    HrmModule,
    InvoiceSettingsModule,
    DiscountsModule,
    VariationsModule,
    InvoicesModule,
  ],
  controllers: [AppController, HealthController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
