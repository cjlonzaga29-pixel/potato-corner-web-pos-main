'use client';

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { LoadingSpinner } from '@/components/shared/feedback/loading-spinner';
import { ImageUpload } from '@/components/shared/forms/image-upload';
import { useUploadProductImage } from '@/hooks/queries/use-products';

interface UploadProductImageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  productId: string;
}

export function UploadProductImageDialog({ open, onOpenChange, productId }: UploadProductImageDialogProps) {
  const uploadImage = useUploadProductImage(productId);

  async function handleImageSelected(file: File) {
    await uploadImage.mutateAsync(file);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Upload Product Image</DialogTitle>
          <DialogDescription>JPEG, PNG, or WebP, up to 5MB. Compressed server-side before storage.</DialogDescription>
        </DialogHeader>

        {uploadImage.isPending ? (
          <div className="flex flex-col items-center gap-3 py-8">
            <LoadingSpinner size="lg" />
            <p className="text-sm text-muted-foreground">Uploading and compressing…</p>
          </div>
        ) : (
          <ImageUpload label="Product Photo" onImageSelected={(file) => void handleImageSelected(file)} />
        )}
      </DialogContent>
    </Dialog>
  );
}
