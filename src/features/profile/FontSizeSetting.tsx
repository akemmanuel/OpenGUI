import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { useFontSize } from "@/hooks/use-font-size";

export function FontSizeSetting() {
  const { t } = useTranslation();
  const [size, setSize] = useFontSize();
  return (
    <div className="space-y-2">
      <div className="flex justify-between">
        <Label id="font-size-label" className="text-xs text-muted-foreground">
          {t("settings.general.fontSize")}
        </Label>
        <span className="text-xs text-muted-foreground">{size}px</span>
      </div>
      <Slider
        aria-labelledby="font-size-label"
        min={12}
        max={20}
        step={1}
        value={[size]}
        onValueChange={(value) => setSize(Array.isArray(value) ? value[0]! : value)}
      />
    </div>
  );
}
