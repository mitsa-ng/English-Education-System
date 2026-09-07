import { Global, Module } from '@nestjs/common';
import { ANALYSIS_ENGINE } from './analysis-engine.interface';
import { AnalyzerHttpClient } from './analyzer-http.client';

@Global()
@Module({
  providers: [{ provide: ANALYSIS_ENGINE, useClass: AnalyzerHttpClient }],
  exports: [ANALYSIS_ENGINE],
})
export class AnalyzerClientModule {}
