import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './common/prisma/prisma.module';
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

@Module({
  imports: [
    PrismaModule,
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
  ],
  controllers: [AppController, HealthController],
  providers: [AppService],
})
export class AppModule {}
