import {
  Body,
  Controller,
  ForbiddenException,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  JwtAuthGuard,
  RolesGuard,
  TenantGuard,
} from '../../common/guards/auth.guards';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/decorators/roles.decorator';
import { ExpensesService } from './expenses.service';
import type {
  CreateExpenseRequest,
  CreateExpenseCategoryRequest,
  UpdateExpenseCategoryRequest,
  UpdateExpenseRequest,
  PayContactDueRequest,
} from '@vonos/types';

@Controller('expenses')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class ExpensesController {
  constructor(private readonly service: ExpensesService) {}

  @Get()
  list(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('locationCode') locationCode?: string,
    @Query('expenseForCustomerId') expenseForCustomerId?: string,
    @Query('contactCustomerId') contactCustomerId?: string,
    @Query('createdById') createdById?: string,
    @Query('categoryId') categoryId?: string,
    @Query('paymentStatus') paymentStatus?: string,
    @Query('includeSummary') includeSummary?: string,
  ) {
    return this.service.listExpenses({
      cursor,
      limit: limit ? Number(limit) : undefined,
      search,
      from,
      to,
      locationCode,
      expenseForCustomerId,
      contactCustomerId,
      createdById,
      categoryId,
      paymentStatus,
      includeSummary: includeSummary !== '0' && includeSummary !== 'false',
    });
  }

  @Post()
  @Roles('admin', 'manager', 'super_admin')
  create(@Body() dto: CreateExpenseRequest) {
    return this.service.createExpense(dto);
  }

  @Get('categories')
  listCategories(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.service.listCategories({
      cursor,
      limit: limit ? Number(limit) : undefined,
      search,
    });
  }

  @Post('categories')
  @Roles('admin', 'manager', 'super_admin')
  createCategory(@Body() dto: CreateExpenseCategoryRequest) {
    return this.service.createCategory(dto);
  }

  @Patch('categories/:id')
  @Roles('admin', 'manager', 'super_admin')
  updateCategory(@Param('id') id: string, @Body() dto: UpdateExpenseCategoryRequest) {
    return this.service.updateCategory(id, dto);
  }

  @Delete('categories/:id')
  @Roles('admin', 'super_admin')
  deleteCategory(@Param('id') id: string) {
    return this.service.deleteCategory(id);
  }

  @Get(':id')
  getById(@Param('id') id: string) {
    return this.service.getExpenseById(id);
  }

  @Post(':id/pay')
  @Roles('admin', 'manager', 'staff', 'super_admin')
  pay(
    @Param('id') id: string,
    @Body() dto: PayContactDueRequest,
    @Req()
    req: {
      user: AuthenticatedUser;
    },
  ) {
    const perms = req.user.tenantRolePermissions ?? [];
    const canEdit =
      req.user.role === 'admin' ||
      req.user.role === 'super_admin' ||
      perms.includes('*') ||
      perms.includes('expense.edit') ||
      perms.includes('expense.create');
    if (!canEdit) throw new ForbiddenException('Missing expense.edit');
    return this.service.payExpense(id, dto);
  }

  @Patch(':id')
  @Roles('admin', 'manager', 'staff', 'super_admin')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateExpenseRequest,
    @Req()
    req: {
      user: AuthenticatedUser;
    },
  ) {
    const perms = req.user.tenantRolePermissions ?? [];
    const canEdit = perms.includes('*') || perms.includes('expense.edit');
    if (!canEdit) throw new ForbiddenException('Missing expense.edit');
    return this.service.updateExpense(id, dto);
  }

  @Delete(':id')
  @Roles('admin', 'manager', 'staff', 'super_admin')
  delete(
    @Param('id') id: string,
    @Req()
    req: {
      user: AuthenticatedUser;
    },
  ) {
    const perms = req.user.tenantRolePermissions ?? [];
    const canDelete = perms.includes('*') || perms.includes('expense.delete');
    if (!canDelete) throw new ForbiddenException('Missing expense.delete');
    return this.service.deleteExpense(id);
  }
}
