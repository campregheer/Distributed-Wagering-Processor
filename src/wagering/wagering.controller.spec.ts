import { Test, TestingModule } from '@nestjs/testing';
import { WageringController } from './wagering.controller';

describe('WageringController', () => {
  let controller: WageringController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WageringController],
    }).compile();

    controller = module.get<WageringController>(WageringController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
