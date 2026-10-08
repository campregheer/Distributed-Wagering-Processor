import { Injectable } from '@nestjs/common';
import type { CanActivate } from '@nestjs/common';

/** Ponto de extensão: substituir por validação OIDC e identidade do provider. */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
