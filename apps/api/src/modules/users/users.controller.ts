import {
  Body,
  Controller,
  Get,
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
  ) {
    if (allTenants === 'true') {
      return this.usersService.listAllTenants(request.user.role);
    }
    return this.usersService.listForTenant();
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
}
