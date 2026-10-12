import type { Logging } from 'homebridge';

/**
 * Aggregated power metrics for upload to SolarCharge API
 */
export interface AggregatedMetrics {
  solar: number; // kW
  export: number; // kW
  pack: number; // kW (grid import)
  usage: number; // kW (local load)
}

export interface InverterSettingsPayload {
  sellFrom: number; // F.eks. 17 (or 0 if deactivated)
  sellTo: number;   // F.eks. 21 (or 0 if deactivated)
  buyFrom: number;  // F.eks. 2  (or 0 if deactivated)
  buyTo: number;    // F.eks. 6  (or 0 if deactivated)
}

/**
 * SolarCharge API client for uploading aggregated inverter telemetry.
 * Handles formatted requests to the SolarCharge backend service.
 */
export class SolarChargeUploader {
  constructor(
    private readonly plantId: string,
    private readonly serialNum: string,
    private readonly log: Logging,
  ) {}


  /**
 * Uploads current SPH settings to the SolarCharge API, mapping 0 to "00" implicitly.
 */
  public async uploadInverterSettings(settings: InverterSettingsPayload): Promise<void> {
    try {
    // Formaterer tallene til 2-cifrede strenge. Hvis tallet er 0, bliver det automatisk til "00"
      const sellFromStr: string = String(settings.sellFrom).padStart(2, '0');
      const sellToStr: string   = String(settings.sellTo).padStart(2, '0');
    
      const buyFromStr: string  = String(settings.buyFrom).padStart(2, '0');
      const buyToStr: string    = String(settings.buyTo).padStart(2, '0');

      const response = await fetch(
        'https://groshapp.com/test/invertersettings', // Test server
        // 'https://compellingsoftware.com/edge/invertersettings', // Production server
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            plantId: this.plantId,
            serialNum: this.serialNum,
            branding: 'sc',
            sellFrom: sellFromStr,
            sellTo: sellToStr,
            buyFrom: buyFromStr,
            buyTo: buyToStr,
          }),
        },
      );

      if (!response.ok) {
        this.log.error(
          `SolarCharge API error updating settings: ${response.status} ${response.statusText}`,
        );
      } else {
        this.log.debug(`Successfully uploaded inverter settings to SolarCharge API -> Sell: ${sellFromStr}-${sellToStr} | Buy: ${buyFromStr}-${buyToStr}`);
      }
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log.error(
        `Could not upload inverter settings to SolarCharge API: ${errorMsg}`,
      );
    }
  }

  /**
   * Upload averaged metrics to SolarCharge API
   * @param metrics Aggregated power metrics (averaged over polling period)
   * @param startTime Time string in HH:MM format (e.g., "14:05")
   * @param endTime Time string in HH:MM format (e.g., "14:10")
   */
  public async uploadMetrics(
    metrics: AggregatedMetrics,
    startTime: string,
    endTime: string,
  ): Promise<void> {
    try {
      const response = await fetch(
        'https://groshapp.com/test/inverterdata', // test server
        // 'https://gr1.compellingsoftware.com/edge/inverterdata', // production server
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            plantId: this.plantId,
            serialNum: this.serialNum,
            branding: 'sc',
            start: startTime, // e.g., "14:05"
            end: endTime, // e.g., "14:10"
            solar: metrics.solar, // Averaged kW (ppv - produced solar power)
            usage: metrics.usage, // Averaged kW (local load consumption)
            export: metrics.export, // Averaged kW (export to grid)
            pack: metrics.pack, // Averaged kW (grid import / battery charge)
          }),
        },
      );

      if (!response.ok) {
        this.log.error(
          `SolarCharge API error: ${response.status} ${response.statusText}`,
        );
      } else {
        this.log.debug('Successfully uploaded aggregated data to SolarCharge API');
      }
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log.error(
        `Could not upload data to SolarCharge API: ${errorMsg}`,
      );
    }
  }
}
