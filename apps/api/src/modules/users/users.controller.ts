import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { CreateUserRequest, InviteUserRequest } from '@vonos/types';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../../common/decorators/roles.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  JwtAuthGuard,
  RolesGuard,
  TenantGuard,
} from '../../common/guards/auth.guards';
import { UsersService } from './users.service';

type AuthedRequest = Request & { user: AuthenticatedUser };

@Controller('users')
@UseGuards(JwtAuthGuard, TenantGuard, RolesGuard)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  list(
    @Req() request: AuthedRequest,
    @Query('allTenants') allTenants?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('role') role?: string,
    @Query('status') status?: string,
  ) {
    const filters = {
      cursor,
      limit: limit ? Number(limit) : undefined,
      search,
      role,
      status,
    };
    if (allTenants === 'true') {
      return this.usersService.listAllTenants(request.user, filters);
    }
    return this.usersService.listForTenant(filters);
  }

  @Get(':id')
  getById(@Req() request: AuthedRequest, @Param('id') id: string) {
    if (id === 'invite') {
      throw new NotFoundException();
    }
    return this.usersService.getById(id, request.user);
  }

  @Post('invite')
  @Roles('admin', 'super_admin')
  invite(@Req() request: AuthedRequest, @Body() body: InviteUserRequest) {
    return this.usersService.inviteUser(request.user, body);
  }

  @Post()
  @Roles('admin', 'super_admin')
  create(@Req() request: AuthedRequest, @Body() body: CreateUserRequest) {
    return this.usersService.createUser(request.user, body);
  }

  @Patch(':id')
  @Roles('admin', 'super_admin')
  update(
    @Req() request: AuthedRequest,
    @Param('id') id: string,
    @Body()
    body: {
      email?: string;
      name?: string;
      role?: InviteUserRequest['role'];
      tenantRoleId?: string | null;
      status?: 'active' | 'suspended' | 'invited';
      password?: string;
    },
  ) {
    return this.usersService.updateUser(request.user, id, body);
  }

  @Delete(':id')
  @Roles('admin', 'super_admin')
  deactivate(@Req() request: AuthedRequest, @Param('id') id: string) {
    return this.usersService.deactivateUser(request.user, id);
  }
}
