import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../../common/decorators/roles.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  JwtAuthGuard,
  RolesGuard,
  TenantGuard,
} from '../../common/guards/auth.guards';
import { HrmService } from './hrm.service';
import type {
  CreatePayrollRequest,
  CreatePayrollGroupRequest,
  CreatePayComponentRequest,
  CreateDesignationRequest,
  CreateEmployeeRequest,
  UpdatePayrollDeductionRequest,
} from '@vonos/types';

type AuthedRequest = Request & { user: AuthenticatedUser };

@Controller('hrm')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class HrmController {
  constructor(private readonly service: HrmService) {}

  @Get('workforce')
  listWorkforce(
    @Req() request: AuthedRequest,
    @Query('allTenants') allTenants?: string,
    @Query('search') search?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const filters = {
      search,
      cursor,
      limit: limit ? Number(limit) : undefined,
    };
    if (allTenants === 'true') {
      return this.service.listWorkforceAllTenants(request.user.role, filters);
    }
    return this.service.listWorkforce(filters);
  }

  @Get('designations')
  listDesignations(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.service.listDesignations({
      cursor,
      limit: limit ? Number(limit) : undefined,
      search,
    });
  }

  @Post('designations')
  @Roles('admin', 'manager')
  createDesignation(@Body() dto: CreateDesignationRequest) {
    return this.service.createDesignation(dto);
  }

  @Get('employees')
  listEmployees(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('designationId') designationId?: string,
    @Query('locationCode') locationCode?: string,
    @Query('serviceStaffOnly') serviceStaffOnly?: string,
  ) {
    return this.service.listEmployees({
      cursor,
      limit: limit ? Number(limit) : undefined,
      search,
      designationId,
      locationCode,
      serviceStaffOnly: serviceStaffOnly === 'true',
    });
  }

  @Post('employees')
  @Roles('admin', 'manager')
  createEmployee(@Body() dto: CreateEmployeeRequest) {
    return this.service.createEmployee(dto);
  }

  @Get('payroll')
  listPayrolls(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('payrollGroupId') payrollGroupId?: string,
    @Query('employeeRecordId') employeeRecordId?: string,
    @Query('locationCode') locationCode?: string,
    @Query('designationId') designationId?: string,
    @Query('month') month?: string,
    @Query('year') year?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortDir') sortDir?: string,
  ) {
    return this.service.listPayrolls({
      cursor,
      limit: limit ? Number(limit) : undefined,
      search,
      payrollGroupId,
      employeeRecordId,
      locationCode,
      designationId,
      month: month ? Number(month) : undefined,
      year: year ? Number(year) : undefined,
      sortBy,
      sortDir: sortDir === 'asc' || sortDir === 'desc' ? sortDir : undefined,
    });
  }

  @Post('payroll')
  @Roles('admin', 'manager')
  createPayroll(@Body() dto: CreatePayrollRequest) {
    return this.service.createPayroll(dto);
  }

  @Patch('payroll/:id/deduction')
  @Roles('admin', 'manager')
  addPayrollDeduction(
    @Param('id') id: string,
    @Body() dto: UpdatePayrollDeductionRequest,
  ) {
    return this.service.addPayrollDeduction(id, dto);
  }

  @Get('payroll-groups')
  listPayrollGroups(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.service.listPayrollGroups({
      cursor,
      limit: limit ? Number(limit) : undefined,
      search,
    });
  }

  @Post('payroll-groups')
  @Roles('admin', 'manager')
  createPayrollGroup(@Body() dto: CreatePayrollGroupRequest) {
    return this.service.createPayrollGroup(dto);
  }

  @Get('pay-components')
  listPayComponents(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.service.listPayComponents({
      cursor,
      limit: limit ? Number(limit) : undefined,
      search,
    });
  }

  @Post('pay-components')
  @Roles('admin', 'manager')
  createPayComponent(@Body() dto: CreatePayComponentRequest) {
    return this.service.createPayComponent(dto);
  }
}
