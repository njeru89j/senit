import { Controller, Get, Param } from '@nestjs/common';
import { ParcelsService } from './parcels.service';

@Controller('public/parcels')
export class PublicParcelsController {
  constructor(private readonly parcelsService: ParcelsService) {}

  @Get('tracking/:trackingNumber')
  findByTrackingNumber(@Param('trackingNumber') trackingNumber: string) {
    return this.parcelsService.findPublicTrackingByNumber(trackingNumber.trim());
  }
}
