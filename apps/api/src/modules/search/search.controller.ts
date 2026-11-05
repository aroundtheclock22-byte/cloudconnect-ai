import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser, RequirePermissions } from '../../common/auth';
import { SearchService } from './search.service';

@ApiTags('search')
@Controller('v1/search')
export class SearchController {
  constructor(private svc: SearchService) {}
  @RequirePermissions('contacts:read') @Get()
  search(@CurrentUser() u: AuthUser, @Query('q') q = '') { return this.svc.search(u.orgId, u.userId, q); }
}
