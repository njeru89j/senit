import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ParcelFilterDto } from './admin.dto';

describe('ParcelFilterDto', () => {
  it('accepts and transforms the filters used by the operations batch screen', async () => {
    const dto = plainToInstance(ParcelFilterDto, { page: '1', limit: '200', search: '', status: 'collected', assignedDriverId: 'driver-1' });
    await expect(validate(dto)).resolves.toHaveLength(0);
    expect(dto.page).toBe(1);
    expect(dto.limit).toBe(200);
  });

  it('rejects an unknown parcel status', async () => {
    const dto = plainToInstance(ParcelFilterDto, { status: 'not-a-status' });
    expect(await validate(dto)).not.toHaveLength(0);
  });
});
